/** Random take, avoiding the one played last time when there's a choice. */
export function pickTake<T>(takes: readonly T[], last: T | undefined, random: () => number = Math.random): T {
  const options = takes.length > 1 ? takes.filter((k) => k !== last) : takes;
  return options[Math.floor(random() * options.length)];
}
