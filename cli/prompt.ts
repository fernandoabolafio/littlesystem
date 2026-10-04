import readline from "node:readline/promises";

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

let rl: readline.Interface | undefined;

/** One interface for the whole run, so typed-ahead answers aren't dropped between questions. */
function prompt(): readline.Interface {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

export function closePrompt() {
  rl?.close();
  rl = undefined;
}

export async function ask(question: string): Promise<string> {
  try {
    return (await prompt().question(question)).trim();
  } catch (e) {
    if ((e as { code?: string }).code === "ABORT_ERR") throw new Error("Cancelled.");
    throw e;
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

/** Numbered menu; returns the chosen index. */
export async function choose(question: string, options: string[], fallback = 0): Promise<number> {
  console.log(question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const answer = await ask(`> [${fallback + 1}] `);
    if (!answer) return fallback;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}
