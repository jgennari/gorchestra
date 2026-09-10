import type { Nodes, Root } from 'mdast'

/** Render only the observed follow-up directive; never forward arbitrary attributes. */
export function remarkCodexFollowups() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value)

    function visit(node: Nodes, insideLink = false) {
      if (node.type === 'textDirective' || node.type === 'leafDirective' || node.type === 'containerDirective') {
        const prompt = node.attributes?.prompt
        const label = textContent(node).trim()
        if (!insideLink && node.type === 'textDirective' && node.name === 'codex-followup' &&
          label && prompt?.trim() && Object.keys(node.attributes ?? {}).length === 1) {
          node.data = {
            hName: 'button',
            hProperties: { 'data-codex-followup': prompt },
            hChildren: [{ type: 'text', value: label }],
          }
        } else {
          // Unknown, incomplete, or unsupported directives remain visible verbatim.
          node.data = {
            hName: node.type === 'textDirective' ? 'span' : 'div',
            hChildren: [{ type: 'text', value: source.slice(node.position?.start.offset, node.position?.end.offset) }],
          }
        }
        return
      }
      if ('children' in node) {
        for (const child of node.children) visit(child, insideLink || node.type === 'link' || node.type === 'linkReference')
      }
    }
    visit(tree)
  }
}

function textContent(node: Nodes): string {
  if ('value' in node) return node.value
  if ('children' in node) return node.children.map(textContent).join('')
  return ''
}
