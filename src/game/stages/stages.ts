import { DUSK_DOJO } from "./dusk-dojo";
import { LUNAR_DOJO } from "./lunar-dojo";
import { WINTER_DOJO } from "./winter-dojo";
import type { StageDefinition } from "./stage-definition";

export type { StageDefinition, StageEffects, StageFighter } from "./stage-definition";

/** Every stage, in stage-select order. The first is the default. With only one, there's no stage select step. */
export const STAGES: readonly StageDefinition[] = [DUSK_DOJO, LUNAR_DOJO, WINTER_DOJO];

/** The stage with this id; the default for an unknown or missing one (e.g. a stage that has since been removed). */
export function stageFor(id: string | undefined): StageDefinition {
  return STAGES.find((s) => s.id === id) ?? STAGES[0];
}

export function randomStage(random: () => number = Math.random): StageDefinition {
  return STAGES[Math.floor(random() * STAGES.length)];
}
