// fsm.js — the bot lifecycle, kept deliberately tiny and explicit.
//
// The two failure modes this exists to prevent, both observed on the live 1.8.8 server:
//   1. Running a behaviour command before AuthMe has authenticated you: the command is
//      cancelled and, for a non-allowlisted command inside the first 1000 ms, the bot is
//      kicked. READY is the only state a behaviour may issue commands from.
//   2. Believing a kicked bot is healthy: minecraft-protocol does not close the socket on
//      kick_disconnect and leaves state === 'play', so a naive "state === play" health check
//      reports a kicked bot as fine forever. DEAD is reached from every other state and is
//      the only state the supervisor treats as "must reconnect".
//
// V2 seam: movement/behaviour progression is NOT a new state. A bot that is READY stays READY
// while following a leader or mining; those are behaviours subscribing to the bus, not phases
// of the connection. Only add a state here if the *transport* contract changes.

export const S = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  PLAY: 'PLAY',            // join_game received; chat() available; NOT authorised to act
  AUTH: 'AUTH',            // against a login plugin; prompt seen or /login sent
  AUTH_FAILED: 'AUTH_FAILED',
  READY: 'READY',          // authenticated; behaviours may run commands
  DEAD: 'DEAD'
})

const LEGAL = {
  [S.DISCONNECTED]: [S.CONNECTING, S.DEAD],
  [S.CONNECTING]: [S.PLAY, S.DEAD, S.DISCONNECTED],
  [S.PLAY]: [S.AUTH, S.READY, S.DEAD],
  [S.AUTH]: [S.READY, S.AUTH_FAILED, S.DEAD],
  // DEAD -> CONNECTING is the rejoin path. Without it a kicked bot could never come back:
  // every later transition would be refused as illegal and the bot would sit in DEAD while
  // its socket was in fact connected again.
  [S.AUTH_FAILED]: [S.CONNECTING, S.DEAD, S.DISCONNECTED],
  [S.READY]: [S.DEAD, S.AUTH, S.DISCONNECTED],   // re-auth after a server-side session drop
  [S.DEAD]: [S.CONNECTING, S.DISCONNECTED]
}

export class Fsm {
  #state
  constructor (initial = S.DISCONNECTED, onChange) {
    this.#state = initial
    this.onChange = onChange
  }

  get state () { return this.#state }
  is (...states) { return states.includes(this.#state) }

  /** Never throws on an illegal transition: one confused bot must not kill a 7-bot fleet.
   *  @returns {boolean} whether the transition was applied */
  to (next) {
    const from = this.#state
    if (from === next) return true
    if (!(LEGAL[from] ?? []).includes(next)) {
      this.onChange?.({ from, to: next, applied: false })
      return false
    }
    this.#state = next
    this.onChange?.({ from, to: next, applied: true })
    return true
  }
}
