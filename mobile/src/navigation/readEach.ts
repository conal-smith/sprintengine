/**
 * Ask every item at once, and handle each answer as it comes, one at a time.
 *
 * For the foreground re-read of every paired desktop's identity: asking one
 * desktop after another made the last wait on all the others, and a desktop
 * that is off held every one after it for the whole read timeout. The answers
 * are still handled one at a time, in the order they arrive, because each
 * writes the stored pairing list, and two writes at once would each start
 * from the list as it was before the other.
 */
export async function readEach<T, A>(
  items: readonly T[],
  read: (item: T) => Promise<A>,
  handle: (item: T, answer: A) => Promise<void>,
): Promise<void> {
  let handling: Promise<void> = Promise.resolve();
  await Promise.all(
    items.map(async (item) => {
      const answer = await read(item);
      const turn = handling.then(() => handle(item, answer));
      // A failed handler does not stop the answers after it.
      handling = turn.catch(() => undefined);
      await turn;
    }),
  );
}
