/** How a vehicle's lamps flash and its front wheels sit, from what the simulation says it shows (`sim/vehicles/shown.ts`). */

/** Flash rate of an indicator, Hz, and the share of each flash that is lit. */
export const BLINK_HZ = 1.5;
const BLINK_DUTY = 0.55;
/** Largest front-wheel steering angle drawn, radians. */
export const MAX_STEER = 0.6;

/** Whether a flashing indicator is lit at this moment of the vehicle's life. */
export function blinkOn(age: number, id: number): boolean {
  const phase = ((id * 0.618034) % 1 + age * BLINK_HZ) % 1;
  return phase < BLINK_DUTY;
}

/** Front-wheel steering angle, radians, positive to the left, for a path of this curvature (`pathCurvature`). */
export function steerAngle(curvature: number, wheelbase: number): number {
  if (wheelbase <= 0) return 0;
  const angle = Math.atan(wheelbase * curvature);
  return Math.max(-MAX_STEER, Math.min(MAX_STEER, angle));
}
