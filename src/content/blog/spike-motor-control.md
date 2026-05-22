---
title: "脉冲神经形态机器人控制笔记"
date: "2026-05-20"
tags: ["技术", "神经形态", "机器人"]
description: "阅读 ED-BioRob 论文后的学习笔记"
---

## 论文简介

最近读了一篇有趣的论文：**ED-BioRob: A Neuromorphic Robotic Arm With FPGA-Based Infrastructure for Bio-Inspired Spiking Motor Controllers**，发表在 Frontiers in Neurorobotics (2020)。

核心思想是将生物神经系统的脉冲信号处理方式应用于机器人机械臂的电机控制。

## 关键概念

### 脉冲频率调制 (PFM)

传统机器人使用 PWM（脉宽调制）驱动电机，而这篇论文使用 PFM（脉冲频率调制）：

- **PWM**: 固定频率，改变占空比
- **PFM**: 固定脉冲宽度，改变频率

PFM 的优势在于低速运行时开关损耗更低，因为脉冲频率直接反映了所需的驱动力。

### 脉冲域 PID 控制器 (sPID)

整个 PID 控制器在脉冲域中实现：

- **比例项 (Kp)**: 通过 Spike-Expander 展宽脉冲
- **积分项 (Ki)**: 通过 Integrate-And-Generate 累积脉冲
- **微分项 (Kd)**: 通过反馈回路计算变化率

## 实验结果

- 位置控制精度: RMSE 最差 3.3°（-90° 到 90°）
- 4 关节同时工作功耗低于 1A
- 成功连接 Dynap-SE 神经形态处理器控制关节

## 启发

这篇论文展示了从脉冲感知到脉冲驱动的完整链路，是神经形态工程走向实际应用的重要一步。对于我们做 EMG 信号处理和机器人控制也有参考价值。
