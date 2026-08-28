// Copyright 2025 ROBOTIS CO., LTD.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// The three human-in-the-loop methods this recording pipeline feeds.
//
// One recorded dataset serves all three; the method only decides how the data
// is FILTERED and WEIGHTED at training time. It is stored with the session so
// a dataset carries how it was collected.
//
// minRun: GR00T's action horizon is 40, so a training sample is a 40-frame
// window. An intervention run shorter than minRun yields ZERO windows -- it is
// not partially useful, it is discarded. This is why the live frame counter
// exists.

export const OnlineRLMethod = {
  HG_DAGGER: 'hg_dagger',
  GATE_AS_POTENTIAL: 'gate_as_potential',
  HIL_SERL: 'hil_serl',
};

export const ONLINE_RL_METHODS = [
  {
    value: OnlineRLMethod.HG_DAGGER,
    label: 'HG-DAgger',
    minRun: 40,
    onlySuccess: true,
    needsReward: false,
    summary:
      'Trains on human-driven frames only, from SUCCESSFUL episodes. '
      + 'Takeovers shorter than 40 frames contribute nothing.',
  },
  {
    value: OnlineRLMethod.GATE_AS_POTENTIAL,
    label: 'Gate-as-potential',
    minRun: 1,
    onlySuccess: false,
    needsReward: false,
    summary:
      'Consumes every frame plus the label of who drove. Reward/potential '
      + 'design lives on the workstation.',
  },
  {
    value: OnlineRLMethod.HIL_SERL,
    label: 'HIL-SERL',
    minRun: 1,
    onlySuccess: false,
    needsReward: true,
    summary:
      'Off-policy RL over transitions. Needs reward and done on every frame, '
      + 'so the outcome must be labelled.',
  },
];

export const getMethod = (value) =>
  ONLINE_RL_METHODS.find((m) => m.value === value) || ONLINE_RL_METHODS[0];

export const EpisodeOutcome = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  DISCARD: 'DISCARD',
};

export default ONLINE_RL_METHODS;
