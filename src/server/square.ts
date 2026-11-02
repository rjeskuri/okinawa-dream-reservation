// Builds the Square client from the Worker's vars and secrets. `env` is an argument because `scheduled()` hands the
// cron jobs theirs, so the routes and the jobs can share this one factory.
import { createSquareClient, type SquareClient, type SquareEnv } from "../lib/square/client.ts";

type SquareVars = Pick<Env, "SQUARE_ENV" | "SQUARE_ACCESS_TOKEN" | "SQUARE_LOCATION_ID">;

export function squareClient(env: SquareVars): SquareClient {
  return createSquareClient({
    accessToken: env.SQUARE_ACCESS_TOKEN,
    // The cast is checked at run time: createSquareClient throws on anything but sandbox or production, so an unset or
    // mistyped SQUARE_ENV cannot reach production.
    env: env.SQUARE_ENV as SquareEnv,
    locationId: env.SQUARE_LOCATION_ID,
    fetch,
  });
}
