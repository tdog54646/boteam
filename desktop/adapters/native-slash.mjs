import { redact } from '../native.mjs'

// A native command is a single token. Only the arguments become free-form text.
export const commandName = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,199}$/u

function display(value, max) {
  return typeof value === 'string' ? redact(value).slice(0, max) : ''
}

export function nativeSlashCatalog(commands, classify) {
  if (!Array.isArray(commands)) return []
  const result = []
  const seen = new Set()
  function append(command, name) {
    if (typeof name !== 'string' || !commandName.test(name) || seen.has(name)) return
    seen.add(name)
    const argumentHint = display(command.argumentHint ?? command.input?.hint, 200)
    result.push({
      name, description: display(command.description, 400),
      ...(argumentHint && { argumentHint }), ...classify(command.name),
    })
  }
  for (const command of commands) append(command, command?.name)
  // Claude may also publish aliases. Canonical entries take precedence and
  // aliases inherit the same restrictions and panel actions as their command.
  for (const command of commands) {
    if (seen.has(command?.name) && Array.isArray(command.aliases))
      for (const alias of command.aliases) append(command, alias)
  }
  return result
}

export function slashPrompt(catalog, name, args, provider) {
  const command = catalog.find(item => item.name === name)
  if (command?.action !== 'prompt') throw new Error(`所选 ${provider} 命令在当前原生会话中不可执行，请重新选择。`)
  return args ? '/' + command.name + ' ' + args : '/' + command.name
}
