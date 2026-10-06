import readline from "node:readline";
import { Writable } from "node:stream";

export async function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive input needs a terminal. Use --from-env for non-interactive setups.");
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
      muted = Boolean(opts.hidden);
    });
  } finally {
    rl.close();
    if (opts.hidden) process.stdout.write("\n");
  }
}
