// A small Markdown renderer that builds DOM nodes and never assigns HTML.
// Transcripts carry model output and tool output verbatim, so nothing in them
// is ever parsed as markup: every character reaches the page through
// textContent or a text node.
//
// It covers what the agents actually write -- paragraphs, headings, lists,
// quotes, fenced code, inline code, bold, italic, links -- and shows anything
// else, tables included, as plain text in a monospace block.

// Magic Context prefixes a reply with a "§N§" recall tag; it is bookkeeping,
// not prose. Mid-stream the tag can be incomplete ("§1"), so hide that too.
export function stripRecallTag(text) {
  if (/^\s*§\d*$/.test(text)) return "";
  return text.replace(/^\s*§\d+§\s*/, "");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// Inline spans: `code` first, so nothing inside it is interpreted; then links,
// bold and italic in what remains.
function appendInline(parent, text) {
  const pieces = text.split(/(`[^`\n]+`)/);
  for (const piece of pieces) {
    if (!piece) continue;
    if (piece.length > 1 && piece.startsWith("`") && piece.endsWith("`")) {
      parent.append(el("code", "md-code", piece.slice(1, -1)));
    } else {
      appendEmphasis(parent, piece);
    }
  }
}

// No _underscore_ italics: agents write snake_case far more often than they
// mean emphasis, and the lookbehind that would tell them apart breaks the
// whole module on iOS Safari before 16.4.
const SPAN = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*/;

function appendEmphasis(parent, text) {
  let rest = text;
  while (rest) {
    const match = SPAN.exec(rest);
    if (!match) {
      parent.append(document.createTextNode(rest));
      return;
    }
    if (match.index) parent.append(document.createTextNode(rest.slice(0, match.index)));
    if (match[1] !== undefined) {
      const href = safeHref(match[2]);
      if (href) {
        const link = el("a", "md-link", match[1]);
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else {
        parent.append(document.createTextNode(match[0]));
      }
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const strong = el("strong");
      appendEmphasis(strong, match[3] ?? match[4]);
      parent.append(strong);
    } else {
      const em = el("em");
      appendEmphasis(em, match[5]);
      parent.append(em);
    }
    rest = rest.slice(match.index + match[0].length);
  }
}

function paragraph(lines) {
  const p = el("p");
  lines.forEach((line, index) => {
    if (index) p.append(el("br"));
    appendInline(p, line);
  });
  return p;
}

export function renderMarkdown(text) {
  const root = document.createDocumentFragment();
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(```+|~~~+)\s*([\w+.-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // the closing fence, or the end of a block still streaming
      const pre = el("pre", "md-pre");
      if (fence[2]) pre.dataset.lang = fence[2];
      pre.append(el("code", null, body.join("\n")));
      root.append(pre);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const h = el(heading[1].length <= 2 ? "h3" : "h4", "md-h");
      appendInline(h, heading[2]);
      root.append(h);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.append(el("hr", "md-hr"));
      i++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(lines[i++]);
      root.append(el("pre", "md-pre md-table", body.join("\n")));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      const quote = el("blockquote", "md-quote");
      quote.append(renderMarkdown(body.join("\n")));
      root.append(quote);
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const list = el(ordered ? "ol" : "ul", "md-list");
      if (ordered) list.start = parseInt(bullet[2], 10) || 1;
      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
        if (!item || /\d/.test(item[2]) !== ordered) break;
        const li = el("li");
        const body = [item[3]];
        i++;
        // Continuation lines indented under the item belong to it.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d{1,3}[.)])\s+/.test(lines[i])) {
          body.push(lines[i++].trim());
        }
        appendInline(li, body.join(" "));
        list.append(li);
      }
      root.append(list);
      continue;
    }

    const body = [];
    while (i < lines.length && lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|\||([-*+]|\d{1,3}[.)])\s)/.test(lines[i])) {
      body.push(lines[i++]);
    }
    if (body.length) root.append(paragraph(body));
    else i++;
  }
  return root;
}
