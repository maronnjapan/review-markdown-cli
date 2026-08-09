const MERMAID_MODULE = 'https://cdn.jsdelivr.net/npm/mermaid@11/+esm';

/**
 * Mermaid is loaded on demand: most documents have no diagrams, and the review
 * UI must keep working when the CDN is unreachable.
 */
export async function renderDiagrams(root, { isStillCurrent = () => true } = {}) {
  const diagrams = root.querySelectorAll('div.mermaid');
  if (diagrams.length === 0 || !isStillCurrent()) return;
  try {
    const { default: mermaid } = await import(MERMAID_MODULE);
    if (!isStillCurrent()) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    await mermaid.run({ nodes: diagrams });
  } catch (error) {
    console.warn('Mermaid render skipped', error);
  }
}
