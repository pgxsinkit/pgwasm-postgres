/**
 * The argument words of a command line initdb hands to `system()` or `popen()`.
 *
 * initdb runs the backend through the shell (`"/pgwasm/bin/postgres" --boot -X 1048576 …`, or
 * `… template1 >"/dev/null"`); the driver runs that backend itself, so it needs the words, not a shell.
 * Single quotes, double quotes (where `\` escapes `"`, `\`, `$` and a backtick) and a bare `\` are
 * honoured, and the first redirection or control operator ends the command, as it would in a shell.
 */
export function commandWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let index = 0;
  const unterminated = (quote: string) => new SyntaxError(`unterminated ${quote} in command line: ${command}`);

  while (index < command.length) {
    const char = command.charAt(index);
    if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      index += 1;
    } else if ("<>|&;()".includes(char)) {
      break;
    } else if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) throw unterminated("'");
      word = (word ?? "") + command.slice(index + 1, close);
      index = close + 1;
    } else if (char === '"') {
      word ??= "";
      index += 1;
      for (;;) {
        if (index >= command.length) throw unterminated('"');
        const inner = command.charAt(index);
        if (inner === '"') break;
        const next = command.charAt(index + 1);
        if (inner === "\\" && next !== "" && '"\\$`'.includes(next)) {
          word += next;
          index += 2;
        } else {
          word += inner;
          index += 1;
        }
      }
      index += 1;
    } else if (char === "\\") {
      word = (word ?? "") + command.charAt(index + 1);
      index += 2;
    } else {
      word = (word ?? "") + char;
      index += 1;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}
