import { randomUUID } from 'node:crypto'
import { permissionCapability, permissionModesForCatalog } from '../permission-modes.mjs'

const stale = () => new Error('频道绑定或操作权限已更改，请检查最新设置后重试。')

export class ChannelPermissions {
  constructor(workspace) {
    this.workspace = workspace
    this.db = workspace.db
    // Existing channels have no row and continue using their chat's settings.
    // New identities and bot bindings start with the CLI's default permission.
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_permissions(
        channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, mode TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS channel_permission_new AFTER INSERT ON channels BEGIN
        INSERT INTO channel_permissions VALUES(NEW.id,'default',lower(hex(randomblob(16))))
          ON CONFLICT(channel) DO UPDATE SET mode=excluded.mode, revision=excluded.revision;
      END;
      CREATE TRIGGER IF NOT EXISTS channel_permission_binding AFTER UPDATE OF botId,generation ON channels
      WHEN OLD.botId != NEW.botId OR OLD.generation != NEW.generation BEGIN
        INSERT INTO channel_permissions VALUES(NEW.id,'default',lower(hex(randomblob(16))))
          ON CONFLICT(channel) DO UPDATE SET mode=excluded.mode, revision=excluded.revision;
      END;
      CREATE TRIGGER IF NOT EXISTS channel_permission_account AFTER UPDATE OF identity,provider ON accounts
      WHEN OLD.identity != NEW.identity OR OLD.provider != NEW.provider BEGIN
        INSERT INTO channel_permissions SELECT c.id,'default',lower(hex(randomblob(16)))
        FROM channels c JOIN bots b ON b.id=c.botId WHERE b.accountId=NEW.id
        ON CONFLICT(channel) DO UPDATE SET mode=excluded.mode, revision=excluded.revision;
      END;`)
  }
  reset(id) {
    this.db.run('INSERT OR REPLACE INTO channel_permissions VALUES(?,?,?)', id, 'default', randomUUID())
  }
  read(id) {
    return this.db.get(`SELECT p.mode AS permission,coalesce(p.revision,c.generation) AS permissionRevision
      FROM channels c LEFT JOIN channel_permissions p ON p.channel=c.id WHERE c.id=?`, id)
  }
  binding(id, botId, revision) {
    const row = this.db.get(`SELECT p.mode AS permission,coalesce(p.revision,c.generation) AS revision,a.provider
      FROM channels c JOIN bots b ON b.id=c.botId JOIN accounts a ON a.id=b.accountId
      LEFT JOIN channel_permissions p ON p.channel=c.id WHERE c.id=? AND b.id=? AND b.archived=0`, id, botId)
    if (!row || (revision !== undefined && row.revision !== revision)) throw stale()
    return row
  }
  modes(provider) { return this.workspace.adapters[provider]?.permissionModes || ['default'] }
  async options({ id, botId, refresh = false }) {
    const { permission, revision, provider } = this.binding(id, botId)
    const modes = this.modes(provider)
    let capabilities, unavailable = false
    if (modes.some(permissionCapability)) {
      try { capabilities = await this.workspace.composerActions({ botId, refresh }) }
      catch { unavailable = true }
      this.binding(id, botId, revision)
    }
    return { permission, revision, unavailable, modes: permissionModesForCatalog(modes, capabilities || {}) }
  }
  async validate(id, botId, permission, revision, signal) {
    const { provider } = this.binding(id, botId, revision)
    if (!this.modes(provider).includes(permission)) throw new Error('此原生工具不支持所选权限模式。')
    const capability = permissionCapability(permission)
    if (capability) {
      const available = await this.workspace.composerActions({ botId, refresh:true })
      signal?.throwIfAborted()
      this.binding(id, botId, revision)
      if (available[capability] !== true) throw new Error('当前原生工具未提供所选操作权限。')
    }
  }
  async save({ id, botId, permission, expectedRevision }) {
    if (typeof expectedRevision !== 'string') throw stale()
    await this.validate(id, botId, permission, expectedRevision)
    this.workspace.lifetime.signal.throwIfAborted()
    const current = this.binding(id, botId, expectedRevision)
    if (current.permission === permission) return this.read(id)
    this.db.run('INSERT OR REPLACE INTO channel_permissions VALUES(?,?,?)', id, permission, randomUUID())
    this.workspace.notify()
    return this.read(id)
  }
}
