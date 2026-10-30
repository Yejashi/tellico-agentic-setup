import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const look = join(root, "bin/tellico-look");

// A gateway that records what it is sent and answers like llama.cpp.
async function gateway(t, status = 200, reply = { choices: [{ message: { content: " A red square. \n" } }] }) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}

function device(t, { mode = "gateway", url, keys = { "api-key": "sk-tellico-device\n" } }) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-look-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config/tellico-qwen");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "client.env"), `TELLICO_MODE='${mode}'\nTELLICO_GATEWAY_URL='${url}'\n`);
  for (const [name, value] of Object.entries(keys)) writeFileSync(join(config, name), value, { mode: 0o600 });
  const image = join(dir, "shot.png");
  writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
  return {
    dir,
    image,
    // Asynchronous: the fake gateway answers on this same event loop.
    run(args) {
      return new Promise(resolve => {
        const child = spawn("sh", [look, ...args], {
          env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, "config") },
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("close", status => resolve({ status, stdout, stderr }));
      });
    },
  };
}

test("asks the gateway's vision model about the image and prints the answer", async t => {
  const g = await gateway(t);
  const d = device(t, { url: g.url });
  const { status, stdout, stderr } = await d.run([d.image, "What colour is it?"]);
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "A red square.\n");
  const [sent] = g.seen;
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.auth, "Bearer sk-tellico-device");
  assert.equal(sent.body.model, "qwen3-vl-8b");
  const [picture, text] = sent.body.messages[0].content;
  assert.equal(picture.image_url.url, "data:image/png;base64," + readFileSync(d.image).toString("base64"));
  assert.equal(text.text, "What colour is it?");
});

test("with no question it asks for a full description", async t => {
  const g = await gateway(t);
  const d = device(t, { url: g.url });
  assert.equal((await d.run([d.image])).status, 0);
  assert.match(g.seen[0].body.messages[0].content[1].text, /Transcribe all visible text/);
});

test("a tunnel install signs in with its gateway key, never the cluster key", async t => {
  const g = await gateway(t);
  const d = device(t, { mode: "tunnel", url: g.url,
    keys: { "api-key": "cluster-key\n", "api-key.gateway": "sk-tellico-gw\n" } });
  assert.equal((await d.run([d.image, "?"])).status, 0);
  assert.equal(g.seen[0].auth, "Bearer sk-tellico-gw");
});

test("a tunnel install without a gateway key says so and sends nothing", async t => {
  const g = await gateway(t);
  const d = device(t, { mode: "tunnel", url: g.url, keys: { "api-key": "cluster-key\n" } });
  const { status, stderr } = await d.run([d.image, "?"]);
  assert.equal(status, 1);
  assert.match(stderr, /api-key\.gateway/);
  assert.equal(g.seen.length, 0);
});

test("a gateway error is reported with its message", async t => {
  const g = await gateway(t, 429, { error: { message: "The vision model is busy." } });
  const d = device(t, { url: g.url });
  const { status, stderr } = await d.run([d.image, "?"]);
  assert.equal(status, 1);
  assert.match(stderr, /429\. The vision model is busy\./);
});

test("refuses a missing file and a non-image before contacting anything", async t => {
  const g = await gateway(t);
  const d = device(t, { url: g.url });
  assert.equal((await d.run([join(d.dir, "nope.png")])).status, 1);
  const text = join(d.dir, "notes.txt");
  writeFileSync(text, "hello");
  const { status, stderr } = await d.run([text]);
  assert.equal(status, 1);
  assert.match(stderr, /not a PNG/);
  assert.equal(g.seen.length, 0);
  assert.equal((await d.run([])).status, 2);
});
