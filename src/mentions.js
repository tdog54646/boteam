const everyone = ["全体成员", "全体", "所有人"];
const separator = /[\s，。！？、：；,.!?:;()（）\[\]{}@＠]/u;

// Resolve display names only at mention boundaries. Duplicate Bot names need
// an explicit ID from the picker, which also shows each bound account.
export function resolveMentions(text, members, explicit = []) {
  const names = [
    ...new Set([...everyone, ...members.map((bot) => bot.name)]),
  ].sort((a, b) => b.length - a.length);
  const tokens = [];
  for (const match of text.matchAll(/[@＠]/gu)) {
    const start = match.index;
    if (start && /[a-z\d_.+-]/i.test(text[start - 1])) continue;
    const rest = text.slice(start + 1);
    const name = names.find(
      (name) =>
        rest.startsWith(name) &&
        (rest.length === name.length || separator.test(rest[name.length])),
    );
    if (!name) continue;
    const all = everyone.includes(name);
    const matches = all ? members : members.filter((bot) => bot.name === name);
    const ids =
      !all && matches.length > 1
        ? matches
            .filter((bot) => explicit.includes(bot.id))
            .map((bot) => bot.id)
        : matches.map((bot) => bot.id);
    tokens.push({
      start,
      end: start + name.length + 1,
      ids,
      ambiguous: !all && !ids.length,
    });
  }
  return tokens;
}
