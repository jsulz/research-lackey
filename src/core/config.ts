/**
 * Typed Run configuration. Values are tuning starting points (T1 spec, "Behavioral rules").
 */
export interface RunConfig {
  /** On a Source's first poll, every Item is recorded but only the newest this many pass onward. */
  first_poll_cap: number;
}

export const CONFIG: RunConfig = {
  first_poll_cap: 10,
};
