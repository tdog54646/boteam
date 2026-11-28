// Adapters declare candidate modes. These two additionally need a capability
// from the current native session before a change can be committed.
const capabilities = new Map([['auto-review', 'autoReview'], ['workspace-auto', 'workspaceAuto']])
export const permissionCapability = mode => capabilities.get(mode)

export function permissionModesForCatalog(modes, catalog, selected) {
  return modes.filter(mode => {
    const capability = permissionCapability(mode)
    return !capability || mode === selected || catalog == null || catalog[capability] === true
  })
}
