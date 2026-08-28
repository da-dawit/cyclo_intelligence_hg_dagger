// Copyright 2025 ROBOTIS CO., LTD.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Preset language instructions for the Task Instruction field.
//
// TRAINED_INSTRUCTION is the exact string the policy was conditioned on.
// Task_3_Screwing (35 episodes -> groot_screwing35) has a tasks.parquet with
// exactly ONE row, so all 62,663 training frames saw this single sentence and
// nothing else.
//
// SUBTASK_INSTRUCTIONS come from that dataset's meta/subtasks.parquet. GR00T
// was NOT conditioned on them: subtask_index is an annotation column consumed
// by the SARM reward models, while the GR00T preprocessor's language_key is
// "task". They are therefore off-distribution prompts -- useful for probing
// stage-wise behaviour, but not what the policy was trained to follow.
// Strings are reproduced verbatim, trailing periods included.

export const TRAINED_INSTRUCTION =
  'Screw the orange bolt into the hole using the driver';

export const SUBTASK_INSTRUCTIONS = [
  'Grab the orange bolt',
  'Place the orange bolt into the hole',
  'Grab the driver.',
  'Screw in the bolt by pushing down.',
  'Go back to home after done.',
];

// dawity/groot_screwing35 16d_30k checkpoint ONLY. Unlike the single-sentence
// TRAINED_INSTRUCTION above, this checkpoint's dataset carries real per-stage
// conditioning (meta/subtasks.parquet, not the off-distribution probe
// SUBTASK_INSTRUCTIONS above is) -- the tokenizer sees these bytes, so a
// paraphrase is a different input. Reproduced byte-exact from
// DEPLOY_16D_30K.md. Do not use these against the older follower/
// checkpoint-30000 (see that checkpoint's own rollback notes), and do not
// use SUBTASK_INSTRUCTIONS above against 16d_30k.
export const SUBTASK_INSTRUCTIONS_16D = [
  'Grab the orange bolt with the left arm',
  'Place the orange bolt into the hole with the left arm',
  'Grab the driver with the right arm',
  'Screw in the bolt by pushing down with the right arm',
  'Return both arms to home',
];

export const TASK_INSTRUCTION_GROUPS = [
  {
    label: 'Trained instruction (recommended)',
    options: [{ label: TRAINED_INSTRUCTION, value: TRAINED_INSTRUCTION }],
  },
  {
    label: 'Subtasks — off-distribution',
    options: SUBTASK_INSTRUCTIONS.map((s, i) => ({
      label: `${i}. ${s}`,
      value: s,
    })),
  },
  {
    label: 'Subtasks — 16d_30k trained (arm-named)',
    options: SUBTASK_INSTRUCTIONS_16D.map((s, i) => ({
      label: `${i}. ${s}`,
      value: s,
    })),
  },
];

export const TASK_INSTRUCTION_VALUES = new Set([
  TRAINED_INSTRUCTION,
  ...SUBTASK_INSTRUCTIONS,
  ...SUBTASK_INSTRUCTIONS_16D,
]);

export default TASK_INSTRUCTION_GROUPS;
