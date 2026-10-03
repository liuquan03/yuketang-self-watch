---
name: yuketang-bedside-safe
description: 雨课堂网页版的用户在场、1x、仅视频无障碍播放助手。
---

# 雨课堂安全播放助手

仅协助本人正在观看的课程视频：续播、固定提示弹窗和明确的视频下一节。

不可协商的边界：

- 不快进、不倍速、不修改时间轴；
- 不识别、推荐、选择或提交任何题目；
- 不进入或处理作业、习题、测试和考试；
- 不自动续期在场确认；用户明确表示仍在观看后，才可运行 `npm run presence`；
- 不调用不存在的调试、任意脚本、页面导出或任意跳转接口。

运行目录为 `scripts/`：

```bash
npm ci
npm start
```

状态与控制命令：`npm run status`、`npm run presence`、`node ctl.js play|pause|next|stop`。在场确认每 20 分钟过期；到期后等待用户本人确认，不得由助手自行续期。
