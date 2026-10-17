// `@sprintengine/conversation-timeline`: a Studio conversation as rows, with no
// React, DOM or Electron in it (phase 9 spec, 5.1). The projection folds a
// conversation's events into entries (turns, tool steps, agents, decisions),
// the timeline groups them into the rows a view draws, and the follower keeps
// both current over a Studio connection.
export * from './conversationProjection.js'
export * from './incrementalConversationProjection.js'
export * from './conversationTimeline.js'
export * from './sessionEventLog.js'
export * from './todoProgress.js'
export * from './backgroundTasks.js'
export * from './goal.js'
export * from './turnFolds.js'
export * from './stepDuration.js'
export * from './stepOutcome.js'
export * from './attachments.js'
export * from './attachedFiles.js'
export * from './follower.js'
export * from './version.js'
