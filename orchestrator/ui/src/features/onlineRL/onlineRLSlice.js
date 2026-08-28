// Copyright 2025 ROBOTIS CO., LTD.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Online-RL session state. The INFERENCE session itself lives in
// features/tasks/taskSlice.js and is only read here -- this page attaches to a
// session started on the Inference page and must never issue LOAD.

import { createSlice } from '@reduxjs/toolkit';
import { OnlineRLMethod } from '../../constants/onlineRLMethods';

const initialState = {
  method: OnlineRLMethod.HG_DAGGER,
  // Start recording automatically on the transition into INFERENCING.
  // On the A2 leader a single tact press BOTH toggles arm engage and triggers
  // recording, so reaching for the button to start recording would also engage
  // a leader arm while the policy is still driving -- and both publish to the
  // same /leader/... topic. Auto-start removes that reach entirely.
  autoRecord: true,
  // Completed intervention runs this episode, in frames.
  runs: [],
  // Frames in the run currently underway (0 when the policy is driving).
  currentRunFrames: 0,
  // Set when an episode ends and an outcome has not been chosen yet. The
  // prompt is blocking on purpose: an episode saved without an outcome is
  // dropped entirely by HG-DAgger's default aggregation.
  pendingOutcomeEpisode: null,
  lastOutcome: null,
  error: '',
  // Session tallies, accumulated as episodes are labelled.
  episodesCollected: 0,
  outcomeCounts: { SUCCESS: 0, FAILURE: 0, DISCARD: 0 },
  sessionInterventionFrames: 0,
  sessionWindows: 0,
};

const onlineRLSlice = createSlice({
  name: 'onlineRL',
  initialState,
  reducers: {
    setMethod: (state, action) => {
      state.method = action.payload;
    },
    setAutoRecord: (state, action) => {
      state.autoRecord = Boolean(action.payload);
    },
    setCurrentRunFrames: (state, action) => {
      state.currentRunFrames = Math.max(0, Number(action.payload) || 0);
    },
    commitRun: (state, action) => {
      const frames = Math.max(0, Number(action.payload) || 0);
      if (frames > 0) state.runs.push(frames);
      state.currentRunFrames = 0;
    },
    // Per-EPISODE reset. The intervention run history must not leak across
    // episodes or the frame counter and window maths would describe the
    // previous run. Called on the recording-start edge as well as after an
    // outcome is submitted.
    resetEpisode: (state) => {
      state.runs = [];
      state.currentRunFrames = 0;
    },
    // Full SESSION reset -- clears tallies too.
    resetSession: (state) => {
      state.runs = [];
      state.currentRunFrames = 0;
      state.pendingOutcomeEpisode = null;
      state.lastOutcome = null;
      state.error = '';
      state.episodesCollected = 0;
      state.outcomeCounts = { SUCCESS: 0, FAILURE: 0, DISCARD: 0 };
      state.sessionInterventionFrames = 0;
      state.sessionWindows = 0;
    },
    recordEpisodeResult: (state, action) => {
      const { outcome, frames, windows } = action.payload || {};
      state.episodesCollected += 1;
      if (state.outcomeCounts[outcome] !== undefined) {
        state.outcomeCounts[outcome] += 1;
      }
      state.sessionInterventionFrames += Number(frames) || 0;
      state.sessionWindows += Number(windows) || 0;
    },
    requestOutcome: (state, action) => {
      state.pendingOutcomeEpisode = action.payload || null;
    },
    clearOutcomeRequest: (state) => {
      state.pendingOutcomeEpisode = null;
    },
    setLastOutcome: (state, action) => {
      state.lastOutcome = action.payload || null;
    },
    setError: (state, action) => {
      state.error = action.payload || '';
    },
  },
});

export const {
  setMethod,
  setAutoRecord,
  setCurrentRunFrames,
  commitRun,
  resetEpisode,
  resetSession,
  recordEpisodeResult,
  requestOutcome,
  clearOutcomeRequest,
  setLastOutcome,
  setError,
} = onlineRLSlice.actions;

export default onlineRLSlice.reducer;
