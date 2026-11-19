/**
 * Which controller is in each gamepad slot, as far as the browser lets us tell.
 *
 * The Gamepad API numbers pads by slot (`Gamepad.index`) and gives no stable id
 * for the physical device. A pad that falls asleep disconnects; when it wakes,
 * the browser puts it in the lowest free slot, which needn't be its old one:
 * with both pads asleep, whichever wakes first takes slot 0. A player bound to
 * "slot 0" would then silently be driven by the other player's controller.
 *
 * So every time a pad connects in a slot, that's a new *connection* with its
 * own number, and a player's binding holds the connection, not just the slot.
 */
export class PadConnections {
  private next = 1;
  /** Slot → its current connection. `confirmed`: seen its gamepadconnected event. */
  private readonly slots = new Map<number, { connection: number; confirmed: boolean; released?: boolean }>();

  /** A gamepadconnected event. */
  connected(index: number): void {
    const slot = this.slots.get(index);
    // Numbered by a poll just before its event arrived: the same connection.
    if (slot && !slot.confirmed) slot.confirmed = true;
    else this.slots.set(index, { connection: this.next++, confirmed: true });
  }

  /**
   * A press to take a seat with: a button down on a pad seen with every button
   * up since it connected. The press that woke a controller (or plugged it in)
   * doesn't count, so a pad that wakes up can't grab a seat before its owner
   * has seen which one is free.
   */
  freshPress(index: number, anyPressed: boolean): boolean {
    this.current(index, true);
    const slot = this.slots.get(index)!;
    if (!anyPressed) slot.released = true;
    return anyPressed && slot.released === true;
  }

  /** A gamepaddisconnected event. */
  disconnected(index: number): void {
    this.slots.delete(index);
  }

  /**
   * The connection in a slot, given whether a pad is there now (`present`), or
   * null. Polls count too: a slot seen empty starts a new connection next time,
   * even if the browser's events were missed.
   */
  current(index: number, present: boolean): number | null {
    if (!present) {
      this.slots.delete(index);
      return null;
    }
    let slot = this.slots.get(index);
    if (!slot) this.slots.set(index, (slot = { connection: this.next++, confirmed: false }));
    return slot.connection;
  }
}

export const padConnections = new PadConnections();

if (typeof window !== "undefined") {
  window.addEventListener("gamepadconnected", (e) => padConnections.connected(e.gamepad.index));
  window.addEventListener("gamepaddisconnected", (e) => padConnections.disconnected(e.gamepad.index));
}
