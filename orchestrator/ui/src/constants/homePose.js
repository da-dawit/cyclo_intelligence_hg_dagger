// Copyright 2025 ROBOTIS CO., LTD.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// Home pose for FFW SG2 Rev1, mirroring
// ffw_bringup/config/ffw_sg2_rev1_follower/ffw_sg2_follower_initial_positions.yaml
//
// IMPORTANT: the joint_trajectory_controllers are REMAPPED at spawn time --
// they subscribe on /leader/... topics, NOT /arm_l_controller/joint_trajectory.
// Publishing to the controller-named topic reaches 0 subscribers and silently
// does nothing. The remaps come from the follower launch's spawner args.

export const HOME_POSE_DURATION_SEC = 10;

export const HOME_POSE_GROUPS = [
  {
    label: 'left arm',
    topic: '/leader/joint_trajectory_command_broadcaster_left/joint_trajectory',
    jointNames: [
      'arm_l_joint1', 'arm_l_joint2', 'arm_l_joint3', 'arm_l_joint4',
      'arm_l_joint5', 'arm_l_joint6', 'arm_l_joint7', 'gripper_l_joint1',
    ],
    positions: [
      0.355859574339658, 0.088958901472462, 0.026029736494434,
      -1.926655901134555, 0.102728775888717, -0.030667631532807,
      -0.236175368706907, 0.0,
    ],
  },
  {
    label: 'right arm',
    topic: '/leader/joint_trajectory_command_broadcaster_right/joint_trajectory',
    jointNames: [
      'arm_r_joint1', 'arm_r_joint2', 'arm_r_joint3', 'arm_r_joint4',
      'arm_r_joint5', 'arm_r_joint6', 'arm_r_joint7', 'gripper_r_joint1',
    ],
    positions: [
      0.417206821630178, -0.035245605446654, 0.013757890191349,
      -1.923611908008594, -0.058279285714749, -0.044485442848684,
      0.233144959990851, 0.001533980787886,
    ],
  },
  {
    label: 'head',
    topic: '/leader/joystick_controller_left/joint_trajectory',
    jointNames: ['head_joint1', 'head_joint2'],
    positions: [0.782330201821470, 0.069029135454647],
  },
  {
    label: 'lift',
    topic: '/leader/joystick_controller_right/joint_trajectory',
    jointNames: ['lift_joint'],
    positions: [-0.22712],
  },
];

export default HOME_POSE_GROUPS;
