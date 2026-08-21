import { resolveInlineCodeWebLink } from "@t3tools/shared/markdownLinks";

interface MarkdownAstNode {
  type?: string;
  value?: string;
  url?: string;
  data?: unknown;
  position?: unknown;
  children?: MarkdownAstNode[];
}

/** Turns a URL wrapped in backticks into a link without dropping its code styling. */
export function remarkLinkifyInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && !insideLink && typeof node.value === "string") {
        const link = resolveInlineCodeWebLink(node.value);
        if (link) {
          const codeNode: MarkdownAstNode = {
            type: "inlineCode",
            value: node.value,
            position: node.position,
          };
          node.type = "link";
          node.url = link.href;
          node.children = [codeNode];
          delete node.value;
          delete node.data;
          return;
        }
      }

      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}
