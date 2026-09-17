import type { Nodes, Root } from 'mdast'

/** Render only the observed Codex directives; never forward arbitrary attributes. */
export function remarkCodexDirectives() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value)

    function visit(node: Nodes, insideLink = false) {
      if (node.type === 'textDirective' || node.type === 'leafDirective' || node.type === 'containerDirective') {
        const attributes = node.attributes ?? {}
        const label = textContent(node).trim()
        const hasPromptAttribute = Object.hasOwn(attributes, 'prompt')
        const followedByIncompleteAttributes = !hasPromptAttribute &&
          source[node.position?.end.offset ?? -1] === '{'
        const prompt = hasPromptAttribute ? attributes.prompt?.trim() : label
        const buttonLabel = label || prompt
        if (!insideLink && node.type === 'textDirective' && node.name === 'codex-followup' &&
          !followedByIncompleteAttributes && buttonLabel && prompt &&
          Object.keys(attributes).every((key) => key === 'prompt')) {
          node.data = {
            hName: 'button',
            hProperties: { 'data-codex-followup': prompt },
            hChildren: [{ type: 'text', value: buttonLabel }],
          }
        } else if (isFileCitation(node, insideLink)) {
          const path = node.attributes?.path?.trim() ?? ''
          node.data = {
            hName: 'a',
            hProperties: { href: path, title: path, 'data-codex-file-citation': path },
            hChildren: [{ type: 'text', value: fileName(path) }],
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

function isFileCitation(node: Nodes, insideLink: boolean) {
  if (insideLink || node.type !== 'textDirective' || node.name !== 'codex-file-citation') return false
  const attributes = node.attributes ?? {}
  const path = attributes.path?.trim()
  const purpose = attributes.purpose?.trim()
  return Boolean(path && purpose && Object.keys(attributes).every((key) => key === 'path' || key === 'purpose'))
}

function fileName(path: string) {
  const normalized = path.replaceAll('\\', '/')
  return normalized.split('/').at(-1) || path
}

function textContent(node: Nodes): string {
  if ('value' in node) return node.value
  if ('children' in node) return node.children.map(textContent).join('')
  return ''
}
