// Copyright 2025 ROBOTIS CO., LTD.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Online-RL Data page.
//
// ATTACHES to an inference session started on the Inference page. It reads
// session state from the shared taskSlice and never issues LOAD -- reloading
// would free and re-read 12.58 GB of GPU weights just because the operator
// changed pages.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import clsx from 'clsx';

import { InferencePhase, RecordPhase } from '../constants/taskPhases';
import { useRosServiceCaller } from '../hooks/useRosServiceCaller';
import ImageGrid from '../components/ImageGrid';
import InferencePanel from '../components/InferencePanel';
import usePolicyBackendStatus from '../hooks/usePolicyBackendStatus';
import ROSLIB from 'roslib';
import rosConnectionManager from '../utils/rosConnectionManager';
import {
  ONLINE_RL_METHODS,
  EpisodeOutcome,
  getMethod,
} from '../constants/onlineRLMethods';
import {
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
} from '../features/onlineRL/onlineRLSlice';

const API_BASE = '/api';
// Same spinner frames and phase wording as InferenceControlPanel, so LOADING
// looks identical on both pages instead of the button just sitting there.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
const PHASE_MESSAGES = {
  [InferencePhase.READY]: 'Ready to start',
  [InferencePhase.LOADING]: 'Loading model / downloading assets...',
  [InferencePhase.INFERENCING]: 'Inferencing',
  [InferencePhase.PAUSED]: 'Paused',
};
const POLL_MS = 100;
// leader_bridge.py republishes ControlModeStatus.active_arms as a plain
// std_msgs/String on this topic. The original robotis_interfaces/msg/
// ControlModeStatus topic cannot be used directly here: rosbridge runs in
// the cyclo_intelligence container, which does not have robotis_interfaces
// importable, so it can never decode that message type. This bridge topic
// only needs a package every ROS environment ships (std_msgs).
const TELEOP_STATUS_TOPIC = '/leader/teleoperation/active_arms_str';

export default function OnlineRLPage({ isActive = true }) {
  const dispatch = useDispatch();

  // ---- shared session state (read-only here) ------------------------------
  const inferencePhase = useSelector(
    (s) => s.tasks?.inferenceStatus?.inferencePhase ?? InferencePhase.READY
  );
  const recordStatus = useSelector((s) => s.tasks?.recordStatus, shallowEqual);
  const fps = useSelector((s) => Number(s.tasks?.recordStatus?.fps) || 30);

  const {
    method, runs, currentRunFrames, pendingOutcomeEpisode, lastOutcome, error,
    autoRecord, episodesCollected, outcomeCounts, sessionInterventionFrames,
    sessionWindows,
  } = useSelector((s) => s.onlineRL, shallowEqual);


  // ControlModeStatus.active_arms -- 'none' | 'left' | 'right' | 'both'.
  // PAUSED only means the POLICY stopped; it does NOT mean a human is driving.
  // Without this the gauge (and the recorded intervention label) would count
  // idle-paused frames as human intervention.
  const rosbridgeUrl = useSelector((st) => st.ros.rosbridgeUrl);
  const [activeArms, setActiveArms] = useState(null);
  const [teleopSubOk, setTeleopSubOk] = useState(false);
  useEffect(() => {
    // state.ros.connected is never dispatched anywhere in this app (only a
    // same-named but unrelated local useState inside useRosTopicSubscription
    // is) -- gating on it here meant this subscription could never fire, on
    // any page load, ever. rosConnectionManager.getConnection() already has
    // its own correct isConnected retry loop below; that is the real signal.
    if (!rosbridgeUrl) return undefined;
    let topic = null;
    let cancelled = false;
    let retry = null;
    const attach = async () => {
      try {
        const ros = await rosConnectionManager.getConnection(rosbridgeUrl);
        if (cancelled) return;
        if (!ros || !ros.isConnected) {
          retry = setTimeout(attach, 1000);
          return;
        }
        topic = new ROSLIB.Topic({
          ros,
          name: TELEOP_STATUS_TOPIC,
          messageType: 'std_msgs/msg/String',
        });
        topic.subscribe((msg) => {
          setTeleopSubOk(true);
          setActiveArms(msg?.data ?? null);
        });
      } catch (e) {
        if (!cancelled) retry = setTimeout(attach, 2000);
      }
    };
    attach();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (topic) { try { topic.unsubscribe(); } catch (e) { /* noop */ } }
    };
  }, [rosbridgeUrl]);

  // null = unknown (leader down / no message yet) -> do not claim HUMAN.
  const teleopEngaged = activeArms == null
    ? null
    : !['', 'none'].includes(String(activeArms).toLowerCase());

  const policyPaused = inferencePhase === InferencePhase.PAUSED;
  const isAuto = inferencePhase === InferencePhase.INFERENCING;
  // 4.2: with no policy running every frame is ambiguous -- there is no
  // policy to have been paused from -- so recording is refused outright.
  // HUMAN = policy paused AND the leader actually engaged.
  const isHuman = policyPaused && teleopEngaged === true;
  const policyLive = policyPaused || isAuto;
  const isRecording = recordStatus?.recordPhase === RecordPhase.RECORDING;

  const methodCfg = useMemo(() => getMethod(method), [method]);
  const minRun = methodCfg.minRun;

  // Reuse the existing command path rather than duplicating the Inference
  // panel. Model selection, policy path and TRT stay on the Inference page --
  // only the collection loop lives here, so the operator never navigates
  // mid-episode.
  const { sendRecordCommand, publishHomePose } = useRosServiceCaller();
  const [busy, setBusy] = useState('');
  const [confirmHome, setConfirmHome] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const goHome = useCallback(async () => {
    setConfirmHome(false);
    setBusy('Home pose');
    try {
      const sent = await publishHomePose();
      dispatch(setError(''));
      // eslint-disable-next-line no-console
      console.log('home pose sent to:', sent.join(', '));
    } catch (e) {
      dispatch(setError(`Home pose failed: ${e.message}`));
    } finally {
      setBusy('');
    }
  }, [publishHomePose, dispatch]);

  // Same two safety gates the Inference panel enforces on Start.
  //  1. backend readiness -- the policy container must actually be up
  //  2. deploy target -- 'robot' means policy actions reach the physical arms
  const serviceType = useSelector((s2) => s2.tasks?.inferenceTaskInfo?.serviceType);
  const inferenceMode = useSelector(
    (s2) => s2.tasks?.inferenceTaskInfo?.inferenceMode || 'simulation'
  );
  const isRobotMode = inferenceMode === 'robot';
  const shouldCheckBackend = !policyLive || isHuman;
  const { readiness } = usePolicyBackendStatus(serviceType, {
    enabled: shouldCheckBackend,
    intervalMs: 2000,
  });
  const backendBlocked = shouldCheckBackend && !readiness.ready;
  const isLoadingModel = inferencePhase === InferencePhase.LOADING;
  const backendWarming = backendBlocked
    && (readiness.state === 'checking' || readiness.state === 'warming');
  const showSpinner = isLoadingModel || isAuto || backendWarming || !!busy;
  const phaseMessage = backendBlocked
    ? readiness.message
    : PHASE_MESSAGES[inferencePhase] || '';

  const [spinnerIndex, setSpinnerIndex] = useState(0);
  useEffect(() => {
    if (!showSpinner) return undefined;
    const id = setInterval(
      () => setSpinnerIndex((prev) => (prev + 1) % SPINNER_FRAMES.length),
      120
    );
    return () => clearInterval(id);
  }, [showSpinner]);
  const startEnabled = !policyLive && !backendBlocked && !busy;

  const run = useCallback(async (label, commandString) => {
    setBusy(label);
    try {
      await sendRecordCommand(commandString);
      dispatch(setError(''));
    } catch (e) {
      dispatch(setError(`${label} failed: ${e.message}`));
    } finally {
      setBusy('');
    }
  }, [sendRecordCommand, dispatch]);


  // ---- intervention run counter -------------------------------------------
  // The page cannot see recorded frames, so the run length is derived from
  // elapsed wall time at the dataset fps. It is an estimate, and labelled as
  // one in the UI -- but it is the only feedback the operator has that a
  // correction was long enough to produce any training windows at all.
  const runStartRef = useRef(null);

  useEffect(() => {
    if (!isRecording) return undefined;
    if (isHuman) {
      if (runStartRef.current === null) runStartRef.current = Date.now();
      const id = setInterval(() => {
        const started = runStartRef.current;
        if (started === null) return;
        dispatch(setCurrentRunFrames(Math.floor(((Date.now() - started) / 1000) * fps)));
      }, POLL_MS);
      return () => clearInterval(id);
    }
    if (runStartRef.current !== null) {
      const frames = Math.floor(((Date.now() - runStartRef.current) / 1000) * fps);
      runStartRef.current = null;
      dispatch(commitRun(frames));
    }
    return undefined;
  }, [isHuman, isRecording, fps, dispatch]);

  // 4.4: if the session dies mid-recording the tail has no policy behind it,
  // so those intervention labels are meaningless -> force DISCARD.
  const prevPolicyLive = useRef(policyLive);
  useEffect(() => {
    if (prevPolicyLive.current && !policyLive && isRecording) {
      dispatch(setError(
        'Policy stopped while recording. This episode must be discarded: the '
        + 'intervention labels after the drop are meaningless.'
      ));
      dispatch(requestOutcome({
        taskName: recordStatus?.taskName,
        taskNum: recordStatus?.taskNum,
        episodeNumber: recordStatus?.currentEpisodeNumber,
        forced: EpisodeOutcome.DISCARD,
      }));
    }
    prevPolicyLive.current = policyLive;
  }, [policyLive, isRecording, recordStatus, dispatch]);

  // Auto-start recording on the READY/LOADING -> INFERENCING edge. Edge, not
  // level, so stopping a recording by hand does not immediately restart it.
  const wasInferencing = useRef(isAuto);
  useEffect(() => {
    if (autoRecord && isAuto && !wasInferencing.current && !isRecording && !busy) {
      run('Start recording', 'start_inference_record');
    }
    wasInferencing.current = isAuto;
  }, [isAuto, autoRecord, isRecording, busy, run]);

  // Clear the intervention run history when a NEW recording starts, so the
  // counter and window maths never describe the previous episode.
  const wasRecording = useRef(isRecording);
  useEffect(() => {
    if (isRecording && !wasRecording.current) {
      runStartRef.current = null;
      dispatch(resetEpisode());
    }
    wasRecording.current = isRecording;
  }, [isRecording, dispatch]);

  const windows = useMemo(
    () => runs.reduce((acc, r) => acc + Math.max(0, r - minRun + 1), 0),
    [runs, minRun]
  );

  const submitOutcome = useCallback(async (outcome) => {
    const ep = pendingOutcomeEpisode || {};
    // The backend's task_name/episode_number fallback reconstructs the path
    // as <root>/<task_name>/<episode_number> -- but the real on-disk folder
    // is always Task_{task_num}_{task_name}_MCAP/<episode_index> (see
    // session_manager.py's _make_save_repo_name), and current_episode_number
    // is the NEXT episode to record, advanced after each save -- the one
    // just labeled is always one behind it. Build the real bag_path
    // directly rather than relying on that reconstruction, which never
    // matched actual folder names for any recording type.
    // ?? only falls back on null/undefined, not '' -- a request captured
    // while recordStatus.taskNum was momentarily blank would otherwise stick
    // with that blank forever (even across retries of the same modal),
    // instead of picking up the now-current value.
    const taskName = ep.taskName || recordStatus?.taskName;
    const taskNum = ep.taskNum || recordStatus?.taskNum;
    const rawEpisodeNumber = ep.episodeNumber || recordStatus?.currentEpisodeNumber;
    const episodeIndex = Math.max(0, Number(rawEpisodeNumber ?? 0) - 1);
    const body = taskNum
      ? {
          outcome,
          bag_path: `/workspace/rosbag2/Task_${taskNum}_${taskName}_MCAP/${episodeIndex}`,
        }
      : {
          // Older session with no taskNum captured yet -- fall back to the
          // previous (best-effort, possibly wrong) behavior rather than
          // failing outright.
          outcome,
          task_name: taskName,
          episode_number: rawEpisodeNumber,
        };
    try {
      const res = await fetch(`${API_BASE}/recording/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      dispatch(recordEpisodeResult({
        outcome,
        frames: runs.reduce((a, r) => a + r, 0),
        windows: runs.reduce((a, r) => a + Math.max(0, r - minRun + 1), 0),
      }));
      dispatch(setLastOutcome(outcome));
      dispatch(setError(''));
      dispatch(clearOutcomeRequest());
      dispatch(resetEpisode());
    } catch (e) {
      dispatch(setError(`Failed to save outcome: ${e.message}`));
    }
  }, [pendingOutcomeEpisode, recordStatus, dispatch, runs, minRun]);

  const card = 'bg-white rounded-lg border border-gray-200 p-5';

  return (
    <div className="w-full h-full p-6 overflow-y-auto">
      <h1 className="text-2xl font-semibold mb-1">Online-RL Data</h1>
      <p className="text-sm text-gray-500 mb-4">
        Take over, record, and label outcomes without leaving this page. Model
        selection and policy loading stay on the Inference page.
      </p>

      {/* Same camera grid the Record and Inference pages use, so the operator
          can watch all three feeds while taking over. */}
      <div className="mb-6">
        <ImageGrid isActive={isActive} />
      </div>

      <div
        className={clsx(
          'rounded-lg p-3 mb-4 text-sm border flex items-center gap-3 flex-wrap',
          isRobotMode
            ? 'bg-red-50 border-red-300 text-red-900'
            : 'bg-slate-50 border-slate-300 text-slate-700'
        )}
      >
        <span className="font-semibold">
          {isRobotMode ? 'Real Robot Deploy — commands ENABLED' : '3D Sim Deploy — commands blocked'}
        </span>
        <span className="opacity-80">
          {isRobotMode
            ? 'Policy actions drive the physical arms.'
            : 'Not sent to the robot — change the deploy target on the Inference page.'}
        </span>
        {backendBlocked && (
          <span className="ml-auto font-medium">Backend: {readiness.message}</span>
        )}
      </div>

      {!policyLive && (
        <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-4 mb-4">
          <div className="font-semibold">Cannot record: no policy running.</div>
          <div className="text-sm mt-1">
            Press <span className="font-semibold">Start policy</span> below —
            recording without a policy produces unusable labels.
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-300 text-red-900 rounded-lg p-3 mb-4 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
      {/* The real Inference config panel, reused rather than duplicated, so
          Preset / Task Instruction / Policy Path / TensorRT / Action Request /
          Inference Hz / Control Hz stay in one implementation. */}
      <div className={clsx(card, 'xl:col-span-1')}>
        <div className="text-sm font-medium text-gray-700 mb-3">Configuration</div>
        <InferencePanel />
      </div>

      <div className={clsx(card, 'xl:col-span-1')}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-medium text-gray-700">Policy</span>
          <span
            className={clsx(
              'ml-auto px-2 py-0.5 rounded text-xs font-semibold',
              isLoadingModel ? 'bg-amber-100 text-amber-800'
                : isAuto ? 'bg-blue-100 text-blue-800'
                  : isHuman ? 'bg-orange-100 text-orange-800'
                    : 'bg-gray-100 text-gray-600'
            )}
          >
            {phaseMessage}
          </span>
          {showSpinner && (
            <span className="font-mono text-blue-500 text-sm">
              {SPINNER_FRAMES[spinnerIndex]}
            </span>
          )}
        </div>
        <div className="flex gap-3 mb-5">
          <button
            type="button"
            disabled={!startEnabled}
            onClick={() => run('Start policy', 'start_inference')}
            title={backendBlocked ? readiness.message : 'Start inference'}
            className="flex-1 px-3 py-2 rounded-md bg-indigo-600 text-white font-medium disabled:bg-gray-300"
          >
            {busy === 'Start policy'
              ? 'Starting…'
              : isLoadingModel
                ? 'Loading weights…'
                : 'Start policy'}
          </button>
          <button
            type="button"
            disabled={!policyLive || !!busy}
            onClick={() => setConfirmClear(true)}
            title="Stop inference and unload the model from GPU"
            className="px-3 py-2 rounded-md bg-red-700 text-white font-medium disabled:bg-gray-300"
          >
            Clear
          </button>
        </div>
        <div className="text-sm font-medium text-gray-700 mb-2">Pause / Resume</div>
        <div className="flex gap-3 mb-5">
          <button
            type="button"
            disabled={!isAuto || !!busy}
            onClick={() => run('Pause', 'stop_inference')}
            className="flex-1 px-3 py-2 rounded-md bg-orange-500 text-white font-medium disabled:bg-gray-300"
          >
            Pause
          </button>
          <button
            type="button"
            disabled={!policyPaused || !!busy}
            onClick={() => run('Resume', 'resume_inference')}
            title={teleopEngaged
              ? 'Disengage the leader first, then resume'
              : 'Hand control back to the policy'}
            className="flex-1 px-3 py-2 rounded-md bg-blue-600 text-white font-medium disabled:bg-gray-300"
          >
            Resume policy
          </button>
        </div>
        <div className="text-sm font-medium text-gray-700 mb-2">Recording</div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={!policyLive || isRecording || !!busy}
            onClick={() => run('Start recording', 'start_inference_record')}
            className="flex-1 px-3 py-2 rounded-md bg-green-600 text-white font-medium disabled:bg-gray-300"
          >
            Start recording
          </button>
          <button
            type="button"
            disabled={!isRecording || !!busy}
            onClick={() => run('Stop recording', 'stop_inference_record')}
            className="flex-1 px-3 py-2 rounded-md bg-gray-700 text-white font-medium disabled:bg-gray-300"
          >
            Stop &amp; save
          </button>
          <button
            type="button"
            disabled={!isRecording || !!busy}
            onClick={() => setConfirmDelete(true)}
            title="Delete this episode's recording entirely"
            className="px-3 py-2 rounded-md bg-red-600 text-white font-medium disabled:bg-gray-300"
          >
            Delete episode
          </button>
        </div>
        <label className="flex items-start gap-2 mt-3 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={autoRecord}
            onChange={(e) => dispatch(setAutoRecord(e.target.checked))}
          />
          <span>
            <span className="font-medium">Auto-record on inference start</span>
            <span className="text-gray-400"> — avoids reaching for the tact mid-run</span>
          </span>
        </label>
        <p className="text-xs text-gray-500 mt-2">
          Paused? You can teleoperate, or send the robot Home. The gauge only
          counts while the leader is actually engaged.
        </p>
      </div>


      <div className={clsx(card, 'xl:col-span-1')}>
        <div className="flex items-center gap-3 mb-3">
          <span
            className={clsx(
              'px-3 py-1 rounded-md font-bold text-white text-lg tracking-wide',
              isHuman ? 'bg-orange-500' : isAuto ? 'bg-blue-600' : 'bg-gray-400'
            )}
          >
            {isHuman ? 'HUMAN' : isAuto ? 'AUTO' : '—'}
          </span>
          <span className="text-xs text-gray-400 ml-2">
            leader: {activeArms == null
              ? (teleopSubOk ? 'waiting…' : 'no signal — is leader_bridge.py running on ai_worker?')
              : `active_arms=${activeArms}`}
          </span>
          <span className="text-sm text-gray-600">
            {isHuman
              ? 'You are driving. These frames are the training signal.'
              : isAuto
                ? 'Policy is driving.'
                : 'No policy running.'}
          </span>
        </div>

        <div className="h-3 w-full bg-gray-200 rounded overflow-hidden mb-1">
          <div
            className={clsx('h-full', currentRunFrames >= minRun ? 'bg-green-500' : 'bg-orange-400')}
            style={{ width: `${Math.min(100, (currentRunFrames / minRun) * 100)}%` }}
          />
        </div>
        <div className="text-sm font-mono">
          {currentRunFrames < minRun ? (
            <span className="text-orange-700">
              {currentRunFrames} / {minRun} frames
              {' — '}{Math.max(0, minRun - currentRunFrames)} more before this
              correction counts
            </span>
          ) : (
            <span className="text-green-700">
              {currentRunFrames} frames → {Math.max(0, currentRunFrames - minRun + 1)} training windows
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-2">
          Episode so far: {runs.length} takeover{runs.length === 1 ? '' : 's'}
          {' → '}{windows} training window{windows === 1 ? '' : 's'}
          {' · '}estimated from elapsed time at {fps} fps
        </div>
      </div>

      <div className={clsx(card, 'xl:col-span-1')}>
        <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
        <select
          className="w-full h-9 px-2 border border-gray-300 rounded-md disabled:bg-gray-100"
          value={method}
          disabled={isRecording}
          onChange={(e) => dispatch(setMethod(e.target.value))}
        >
          {ONLINE_RL_METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-2">{methodCfg.summary}</p>
        {isRecording && (
          <p className="text-xs text-gray-400 mt-1">
            Locked while recording — switching mid-episode would invalidate the
            labels already written.
          </p>
        )}
      </div>
      </div>

      <div className={clsx(card, 'mt-6')}>
        <div className="text-sm font-medium text-gray-700 mb-3">This session</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <div>
            <div className="text-2xl font-semibold">{episodesCollected}</div>
            <div className="text-xs text-gray-500">episodes labelled</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-green-700">
              {outcomeCounts?.SUCCESS ?? 0}
            </div>
            <div className="text-xs text-gray-500">
              SUCCESS{methodCfg.onlySuccess ? ' (only these train)' : ''}
            </div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-red-700">
              {outcomeCounts?.FAILURE ?? 0}
            </div>
            <div className="text-xs text-gray-500">FAILURE</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-gray-600">
              {outcomeCounts?.DISCARD ?? 0}
            </div>
            <div className="text-xs text-gray-500">DISCARD</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{sessionWindows}</div>
            <div className="text-xs text-gray-500">
              training windows ({sessionInterventionFrames} intervened frames)
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-3">
          This browser session only, not a read of disk. Frames estimated at {fps} fps.
        </p>
      </div>

      <div className={clsx(card, 'mt-6')}>
        <button
          type="button"
          className="px-4 py-2 rounded-md bg-blue-600 text-white disabled:bg-gray-300"
          disabled={!policyLive}
          onClick={() => dispatch(requestOutcome({
            taskName: recordStatus?.taskName,
            taskNum: recordStatus?.taskNum,
            episodeNumber: recordStatus?.currentEpisodeNumber,
          }))}
        >
          End episode &amp; label outcome
        </button>
        <button
          type="button"
          className="ml-3 px-4 py-2 rounded-md bg-slate-700 text-white disabled:bg-gray-300"
          disabled={!!busy || isAuto || teleopEngaged === true}
          onClick={() => setConfirmHome(true)}
          title={isAuto
            ? 'Pause the policy first'
            : teleopEngaged === true
              ? 'Disengage the leader first — it publishes on the same topics'
              : 'Send the follower to its configured init pose'}
        >
          {busy === 'Home pose' ? 'Homing…' : 'Home pose'}
        </button>
        <button
          type="button"
          className="ml-3 px-4 py-2 rounded-md bg-red-700 text-white disabled:bg-gray-300"
          disabled={isRecording || !!busy}
          onClick={() => setConfirmReset(true)}
          title={isRecording
            ? 'Stop the recording first'
            : 'Clear the on-screen tallies only — no recorded data is touched'}
        >
          Clear counters
        </button>
        {lastOutcome && (
          <span className="ml-3 text-sm text-gray-600">Last: {lastOutcome}</span>
        )}
      </div>

      {confirmClear && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[28rem]">
            <h2 className="text-lg font-semibold mb-1">Clear the policy?</h2>
            <p className="text-sm text-gray-600 mb-4">
              Stops inference and <span className="font-semibold">unloads the model
              from GPU</span>. Restarting it re-reads ~12.6&nbsp;GB of weights, which
              takes a while. Use <span className="font-semibold">Take over</span> if
              you only want to pause — that keeps the model resident.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setConfirmClear(false); run('Clear', 'finish'); }}
                className="flex-1 px-3 py-2 rounded-md bg-red-700 text-white font-medium"
              >
                Clear &amp; unload
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="flex-1 px-3 py-2 rounded-md bg-gray-200 text-gray-800 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[30rem]">
            <h2 className="text-lg font-semibold mb-1">Delete this episode?</h2>
            <p className="text-sm text-gray-600 mb-2">
              Deletes the <span className="font-semibold">entire recording</span> for
              this episode — the MCAP bag, the MP4s, camera info and
              episode_info.json.
            </p>
            <p className="text-sm text-gray-600 mb-4">
              That includes{' '}
              <span className="font-semibold">all human intervention frames</span> in
              it. A recording is one unit; the human and policy parts cannot be
              separated. The episode number is reused by the next recording.
              <span className="font-semibold"> This cannot be undone.</span>
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  run('Delete episode', 'cancel_inference_record');
                  dispatch(resetEpisode());
                }}
                className="flex-1 px-3 py-2 rounded-md bg-red-600 text-white font-medium"
              >
                Delete recording
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="flex-1 px-3 py-2 rounded-md bg-gray-200 text-gray-800 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmReset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[28rem]">
            <h2 className="text-lg font-semibold mb-1">Clear counters?</h2>
            <p className="text-sm text-gray-600 mb-4">
              Clears the on-screen tallies, intervention run history, and any
              pending outcome prompt.
              <span className="font-semibold"> Nothing on disk is touched</span> —
              to remove a recording use <span className="font-semibold">Delete episode</span>.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { dispatch(resetSession()); setConfirmReset(false); }}
                className="flex-1 px-3 py-2 rounded-md bg-red-700 text-white font-medium"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="flex-1 px-3 py-2 rounded-md bg-gray-200 text-gray-800 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmHome && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[28rem]">
            <h2 className="text-lg font-semibold mb-1">Send robot to home pose?</h2>
            <p className="text-sm text-gray-600 mb-4">
              Moves both arms, head and lift to the configured init pose over 10
              seconds. Make sure teleop is <span className="font-semibold">disengaged</span> —
              the leader publishes on the same topics and would fight this command.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={goHome}
                className="flex-1 px-3 py-2 rounded-md bg-slate-700 text-white font-medium"
              >
                Go home
              </button>
              <button
                type="button"
                onClick={() => setConfirmHome(false)}
                className="flex-1 px-3 py-2 rounded-md bg-gray-200 text-gray-800 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingOutcomeEpisode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[26rem]">
            <h2 className="text-lg font-semibold mb-1">Label this episode</h2>
            <p className="text-sm text-gray-600 mb-4">
              Required. HG-DAgger uses successful episodes only, so an episode
              saved without an outcome is dropped entirely — not merely missing a
              reward. There is no default on purpose.
            </p>
            <div className="flex gap-3">
              {[EpisodeOutcome.SUCCESS, EpisodeOutcome.FAILURE, EpisodeOutcome.DISCARD].map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => submitOutcome(o)}
                  className={clsx(
                    'flex-1 px-3 py-2 rounded-md text-white font-medium',
                    o === EpisodeOutcome.SUCCESS && 'bg-green-600',
                    o === EpisodeOutcome.FAILURE && 'bg-red-600',
                    o === EpisodeOutcome.DISCARD && 'bg-gray-600'
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
