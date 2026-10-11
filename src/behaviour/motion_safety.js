// Small read-only helpers around Mineflayer's live player entity.  Behaviours use these for
// decisions only; the physics engine remains the sole writer of position and velocity.

function finitePosition (position) {
  return position && ['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis]))
}

/** A snapshot, rather than Mineflayer's mutable Vec3, for a movement decision made across awaits. */
export function nativePosition (transport) {
  const entity = transport?.mc?.entity
  const position = entity?.position ?? transport?.pos
  if (!finitePosition(position)) return null
  return { x: position.x, y: position.y, z: position.z }
}

/**
 * A read-only snapshot of Mineflayer's physics velocity.  The value remains in native
 * blocks-per-tick units; callers must never turn it into a position correction.
 */
export function nativeVelocity (transport) {
  const velocity = transport?.mc?.entity?.velocity
  if (!finitePosition(velocity)) return null
  return {
    x: velocity.x,
    y: velocity.y,
    z: velocity.z,
    horizontal: Math.hypot(velocity.x, velocity.z)
  }
}

/** True only for a floor that the loaded world positively identifies as solid. */
export function hasObservedFloor (transport, position = nativePosition(transport)) {
  if (!position || typeof transport?.blockAt !== 'function') return false
  try {
    const floor = transport.blockAt(Math.floor(position.x), Math.floor(position.y) - 1, Math.floor(position.z))
    return floor?.boundingBox === 'block'
  } catch {
    return false
  }
}

/**
 * Detect an unsupported descent without predicting a trajectory ourselves.  Mineflayer owns the
 * actual velocity and position; this only tells a behaviour to release movement keys while the
 * client is already falling.  A jump or a normal step down is not treated as a fall until its
 * vertical velocity is downward and there is no observed floor under the player.
 */
export function fallingWithoutSupport (transport) {
  const entity = transport?.mc?.entity
  if (!entity || entity.onGround !== false) return false
  const verticalVelocity = Number(entity.velocity?.y)
  if (!Number.isFinite(verticalVelocity) || verticalVelocity >= -0.01) return false
  return !hasObservedFloor(transport, nativePosition(transport))
}

export function nativeFallReason (transport) {
  return fallingWithoutSupport(transport) ? 'bot is falling without a confirmed supporting block' : null
}
