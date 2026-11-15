// A user's action and its state, free of React so that it can be tested: whether it is under way and why it failed
// last. useAction (api.ts) is the React side; it replaces the busy and error state that each button kept by hand.

export interface ActionState { busy: boolean; error: string | undefined }

const idle: ActionState = { busy: false, error: undefined };

export class Action {
  private running = 0;
  private state: ActionState = idle;
  private readonly changed: (s: ActionState) => void;
  constructor(changed: (s: ActionState) => void) { this.changed = changed; }

  get current(): ActionState { return this.state; }

  /**
   * Runs `work`: busy until it (and any other run of this action) settles, the last error cleared when it starts and
   * set to the failure's message when it fails. `done` gets the result of a success. Resolves true on success, false on
   * failure; never rejects.
   */
  readonly run = async <T>(work: () => Promise<T>, done?: (value: T) => void): Promise<boolean> => {
    this.running++;
    this.set({ busy: true, error: undefined });
    let ok = false, value: T | undefined, error: string | undefined;
    try { value = await work(); ok = true; }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    this.running--;
    this.set({ busy: this.running > 0, error });
    if (ok) done?.(value as T);
    return ok;
  };

  /** Shows a failure found before any request (a check of the input), or clears it. */
  readonly fail = (error: string | undefined): void => { this.set({ ...this.state, error }); };

  private set(s: ActionState): void {
    if (s.busy === this.state.busy && s.error === this.state.error) return;
    this.state = s;
    this.changed(s);
  }
}
