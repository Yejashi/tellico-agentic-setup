import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

// A HOME with the client install already in place, plus stubs for everything
// the installer would otherwise reach out to: the OpenCode binary it checks the
// major version of, the systemd user manager, and the gateway it mints a key
// from.
function fixture(t, { major = "2", gateway = true, minted = "sk-tellico-TESTKEY123" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-remote-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, ".local/bin");
  const stubs = join(dir, "stubs");
  const configHome = join(dir, "config");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stubs);
  mkdirSync(join(configHome, "tellico-qwen"), { recursive: true });

  // The installed launcher: only its path and its serve mode are inspected.
  writeFileSync(join(bin, "opencode-tellico"),
    '#!/bin/sh\n# marker for the serve check: "$1" = serve\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(configHome, "tellico-qwen/client.env"), "TELLICO_MODE='tunnel'\n");
  writeFileSync(join(configHome, "tellico-qwen/api-key"), "sk-cluster\n", { mode: 0o600 });

  writeFileSync(join(stubs, "opencode"),
    `#!/bin/sh\necho "opencode v${major}.0.26"\n`, { mode: 0o755 });
  writeFileSync(join(stubs, "systemctl"),
    '#!/bin/sh\n[ "$1" = --user ] || exit 1\nexit 0\n', { mode: 0o755 });
  // Writes what the real one writes: the key on an indented line, once.
  writeFileSync(join(bin, "tellico-gateway"), `#!/bin/sh
case $1 in
  list-users) printf 'USER MAX-PARALLEL\\nbefikir 4\\n' ;;
  add-user) printf 'Added %s.\\n\\n  %s\\n' "$2" "${minted}" ;;
  restart|status) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  if (gateway) {
    mkdirSync(join(configHome, "tellico-gateway"), { recursive: true });
    writeFileSync(join(configHome, "tellico-gateway/gateway.env"),
      'TELLICO_GATEWAY_PORT="4000"\n', { mode: 0o600 });
  }

  const env = {
    // Stubs first, so they shadow any real opencode, systemctl or gateway on
    // this machine; the rest of PATH still supplies coreutils and python3.
    PATH: `${stubs}:${bin}:${process.env.PATH}`,
    HOME: dir,
    XDG_CONFIG_HOME: configHome,
  };
  return {
    dir,
    configHome,
    remoteDir: join(configHome, "tellico-remote"),
    run(args = []) {
      const result = spawnSync("sh", [join(root, "remote/install-remote.sh"), "--no-start", ...args],
        { env, encoding: "utf8", timeout: 20000 });
      assert.ifError(result.error);
      return result;
    },
    envFile() {
      const text = readFileSync(join(configHome, "tellico-remote/remote.env"), "utf8");
      return Object.fromEntries([...text.matchAll(/^(\w+)="(.*)"$/gm)].map(m => [m[1], m[2]]));
    },
    unit() {
      return readFileSync(join(configHome, "systemd/user/tellico-remote.service"), "utf8");
    },
  };
}

test("a default install serves on loopback and reaches the models through the local gateway", t => {
  const f = fixture(t);
  const { status, stdout } = f.run();
  assert.equal(status, 0, stdout);
  const env = f.envFile();
  assert.equal(env.TELLICO_REMOTE_BIND, "127.0.0.1");
  assert.equal(env.TELLICO_REMOTE_PORT, "4096");
  // A gateway is installed here, so it is preferred over the raw tunnel: that
  // is what keeps remote sessions capped and accounted.
  assert.equal(env.TELLICO_REMOTE_CONNECTION, "gateway");
  assert.equal(env.TELLICO_CONNECTION, "gateway");
  // Loopback, not the published URL: no reason to leave the host and come back
  // through TLS and the proxy.
  assert.equal(env.TELLICO_CONNECTION_GATEWAY_URL, "http://127.0.0.1:4000/v1");
  assert.ok(env.OPENCODE_PASSWORD.length >= 20, env.OPENCODE_PASSWORD.length);
});

test("the password is generated once, kept 0600, and only rotated when asked", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const first = readFileSync(join(f.remoteDir, "password"), "utf8");
  assert.ok(first.trim().length >= 20);
  assert.equal(statSync(join(f.remoteDir, "password")).mode & 0o777, 0o600);
  assert.equal(statSync(f.remoteDir).mode & 0o777, 0o700);

  // A rerun must not invalidate a paired phone or the proxy's hash.
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.remoteDir, "password"), "utf8"), first);

  assert.equal(f.run(["--rotate-password"]).status, 0);
  assert.notEqual(readFileSync(join(f.remoteDir, "password"), "utf8"), first);
});

test("the settings file holds the only plaintext copy and stays 0600", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const envPath = join(f.remoteDir, "remote.env");
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  // The unit is world-readable, so the password must reach it by reference.
  const unit = f.unit();
  assert.ok(unit.includes(`EnvironmentFile=${envPath}`));
  assert.ok(!unit.includes(f.envFile().OPENCODE_PASSWORD));
});

test("the unit runs the launcher's serve mode in the workspace, port driven by settings", t => {
  const f = fixture(t);
  assert.equal(f.run(["--workspace", join(f.dir, "scratch"), "--port", "4321"]).status, 0);
  const unit = f.unit();
  assert.ok(unit.includes(`WorkingDirectory=${join(f.dir, "scratch")}`));
  assert.ok(unit.includes(`${join(f.dir, ".local/bin")}/opencode-tellico serve`));
  // Bind and port come from the env file, so changing them needs no reinstall.
  assert.ok(unit.includes("--hostname ${TELLICO_REMOTE_BIND} --port ${TELLICO_REMOTE_PORT}"));
  assert.equal(f.envFile().TELLICO_REMOTE_PORT, "4321");
  assert.equal(statSync(join(f.dir, "scratch")).isDirectory(), true);
});

test("a gateway connection gets a key of its own, minted under its own user", t => {
  const f = fixture(t);
  assert.equal(f.run(["--gateway-user", "phone"]).status, 0);
  // The installed connection is the tunnel, so the gateway key lives beside it
  // under the suffixed name the launcher looks for.
  const keyPath = join(f.configHome, "tellico-qwen/api-key.gateway");
  assert.equal(readFileSync(keyPath, "utf8").trim(), "sk-tellico-TESTKEY123");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(f.envFile().TELLICO_REMOTE_GATEWAY_USER, "phone");
});

test("a gateway user that already holds a key is reported, not silently re-minted", t => {
  const f = fixture(t);
  const { status, stderr } = f.run(["--gateway-user", "befikir"]);
  assert.equal(status, 1);
  assert.match(stderr, /already holds a key/);
  assert.match(stderr, /revoke befikir/);
});

test("the tunnel connection needs no gateway and no key", t => {
  const f = fixture(t, { gateway: false });
  assert.equal(f.run(["--connection", "tunnel"]).status, 0);
  assert.equal(f.envFile().TELLICO_CONNECTION, "tunnel");
});

test("without a gateway installed it falls back to the connection install.sh set up", t => {
  const f = fixture(t, { gateway: false });
  assert.equal(f.run().status, 0);
  assert.equal(f.envFile().TELLICO_REMOTE_CONNECTION, "tunnel");
});

test("asking for the gateway with no key and no local gateway explains both ways out", t => {
  const f = fixture(t, { gateway: false });
  const { status, stderr } = f.run(["--connection", "gateway"]);
  assert.equal(status, 1);
  assert.match(stderr, /no key for the gateway connection/);
  assert.match(stderr, /--connection tunnel/);
});

test("OpenCode 1 is refused, because the phone client is v2 only", t => {
  const f = fixture(t, { major: "1" });
  const { status, stderr } = f.run();
  assert.equal(status, 1);
  assert.match(stderr, /OpenCode 1 has no web app/);
  assert.match(stderr, /opencode upgrade --major/);
});

test("the published origin defaults to the one the repository records", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const recorded = readFileSync(join(root, "config/gateway-url"), "utf8").trim().replace(/\/v1\/*$/, "");
  assert.equal(f.envFile().TELLICO_REMOTE_PUBLIC_URL, recorded);
  assert.ok(!recorded.endsWith("/v1"));

  assert.equal(f.run(["--public-url", "https://other.example"]).status, 0);
  assert.equal(f.envFile().TELLICO_REMOTE_PUBLIC_URL, "https://other.example");
});

test("a bind off loopback is allowed but warned about", t => {
  const f = fixture(t);
  const { status, stderr } = f.run(["--bind", "0.0.0.0"]);
  assert.equal(status, 0);
  assert.match(stderr, /run commands on this host/);
});

test("a launcher without the serve mode is named as the thing to update", t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, ".local/bin/opencode-tellico"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { status, stderr } = f.run();
  assert.equal(status, 1);
  assert.match(stderr, /predates its serve mode/);
  assert.match(stderr, /install\.sh --no-start/);
});

test("the control script is installed executable", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const path = join(f.dir, ".local/bin/tellico-remote");
  assert.ok(statSync(path).mode & 0o111);
  assert.equal(readFileSync(path, "utf8"), readFileSync(join(root, "remote/bin/tellico-remote"), "utf8"));
});

test("the shipped Caddy example keeps the API paths on the gateway and never a real hash", t => {
  const text = readFileSync(join(root, "remote/caddy/Caddyfile.example"), "utf8");
  // The gateway's matcher must come first, or the catch-all swallows /v1.
  assert.ok(text.indexOf("@gateway path /v1 /v1/* /health") < text.indexOf("handle {"));
  assert.ok(text.includes("reverse_proxy 127.0.0.1:4000"));
  assert.ok(text.includes("reverse_proxy 127.0.0.1:4096"));
  // Streaming must not be buffered on either path.
  assert.equal(text.match(/flush_interval -1/g).length, 2);
  assert.ok(text.includes("REPLACE_WITH_YOUR_BCRYPT_HASH"));
  assert.ok(!/\$2[aby]\$\d\d\$/.test(text), "no real bcrypt hash may be committed");
});
