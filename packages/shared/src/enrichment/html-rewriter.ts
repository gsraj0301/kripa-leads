import {
  absoluteUrl,
  extractCopyrightYear,
  extractEmailsFromText,
  extractPhonesFromText,
  normalizeEmail,
  normalizePhone,
  normalizeText,
  socialHostOf,
  unique,
} from "./html";
import type { LinkRef, PageExtraction } from "./types";

interface RewriterElement {
  getAttribute(name: string): string | null;
  remove(): void;
  onEndTag(handler: () => void): void;
}

interface RewriterText {
  readonly text: string;
}

interface RewriterHandlers {
  element?(element: RewriterElement): void;
  text?(text: RewriterText): void;
}

interface Rewriter {
  on(selector: string, handlers: RewriterHandlers): Rewriter;
  onDocument(handlers: { text?(text: RewriterText): void }): Rewriter;
  transform(response: Response): Response;
}

type RewriterConstructor = new () => Rewriter;

function rewriterConstructor(): RewriterConstructor {
  const ctor = (globalThis as { HTMLRewriter?: RewriterConstructor }).HTMLRewriter;
  if (!ctor) throw new Error("HTMLRewriter is not available in this runtime.");
  return ctor;
}

export async function extractPageWithHtmlRewriter(
  html: string,
  baseUrl: string,
  now = new Date(),
): Promise<PageExtraction> {
  const titleParts: string[] = [];
  const links: LinkRef[] = [];
  let currentLink: { href: string; text: string } | null = null;
  let description: string | null = null;
  let hasContactForm = false;

  const HTMLRewriterClass = rewriterConstructor();
  const rewriter = new HTMLRewriterClass()
    .on("script, style, noscript, svg, template", {
      element(element) {
        element.remove();
      },
    })
    .on("title", {
      text(text) {
        titleParts.push(text.text);
      },
    })
    .on("meta", {
      element(element) {
        if (description) return;
        const name = (element.getAttribute("name") ?? "").toLowerCase();
        const property = (element.getAttribute("property") ?? "").toLowerCase();
        if (name === "description" || property === "og:description") {
          description = normalizeText(element.getAttribute("content") ?? "") || null;
        }
      },
    })
    .on("a[href]", {
      element(element) {
        currentLink = { href: element.getAttribute("href") ?? "", text: "" };
        element.onEndTag(() => {
          if (currentLink) {
            links.push({ href: currentLink.href, text: normalizeText(currentLink.text) });
            currentLink = null;
          }
        });
      },
      text(text) {
        if (currentLink) currentLink.text += text.text;
      },
    })
    .on("form", {
      element(element) {
        const action = (element.getAttribute("action") ?? "").toLowerCase();
        if (/contact|enquir|reach|get-in-touch/.test(action)) hasContactForm = true;
      },
    })
    .on("input", {
      element(element) {
        if ((element.getAttribute("type") ?? "").toLowerCase() === "email") hasContactForm = true;
      },
    })
    .on("textarea", {
      element() {
        hasContactForm = true;
      },
    });

  const cleanedHtml = await rewriter
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();

  // Text handlers still fire for content that a sibling element handler
  // removes, so collect visible text from the cleaned markup in a second pass.
  const textParts: string[] = [];
  const contentRewriter = new HTMLRewriterClass().onDocument({
    text(text) {
      textParts.push(text.text);
    },
  });
  await contentRewriter
    .transform(new Response(cleanedHtml, { headers: { "content-type": "text/html" } }))
    .text();

  const text = normalizeText(textParts.join(" "));
  const title = normalizeText(titleParts.join(" ")) || null;
  const emails: string[] = [];
  const phones: string[] = [];
  const socialLinks: string[] = [];

  for (const link of links) {
    const href = link.href.trim();
    if (/^mailto:/i.test(href)) {
      const email = normalizeEmail(href);
      if (email) emails.push(email);
    } else if (/^tel:/i.test(href)) {
      const phone = normalizePhone(href);
      if (phone) phones.push(phone);
    }

    const absolute = absoluteUrl(href, baseUrl);
    if (absolute && socialHostOf(absolute)) socialLinks.push(absolute);
  }

  emails.push(...extractEmailsFromText(text));
  phones.push(...extractPhonesFromText(text));

  return {
    title,
    description,
    text,
    links,
    emails: unique(emails),
    phones: unique(phones),
    socialLinks: unique(socialLinks),
    hasContactForm,
    copyrightYear: extractCopyrightYear(text, now),
  };
}
