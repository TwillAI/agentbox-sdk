export function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function toShellCommand(command: string | string[]): string {
  if (typeof command === "string") {
    return command;
  }

  return command.map(shellQuote).join(" ");
}
