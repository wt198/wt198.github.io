---
title: "用 Astro 搭建个人网站"
date: "2026-05-22"
tags: ["技术", "建站"]
description: "记录从零开始用 Astro 搭建个人博客的过程"
---

## 为什么要建个人网站

在这个信息碎片化的时代，拥有一个属于自己的空间变得越来越重要。社交媒体的算法决定了你看到什么，而个人网站让你完全掌控自己的内容。

## 为什么选择 Astro

之前对比了几个方案：

- **WordPress** — 需要服务器和数据库，维护成本高
- **Hugo** — 速度快，但模板语法不够直观
- **Next.js** — 功能强大但对博客来说偏重
- **Astro** — 零 JS 默认输出，Markdown 原生支持，构建飞快

Astro 的"岛屿架构"意味着页面默认是纯静态 HTML，只有需要交互的组件才会加载 JavaScript。对于一个以内容为主的博客来说，这是最理想的选择。

## 搭建过程

整个过程其实很简单：

1. `npm create astro@latest` 创建项目
2. 写 Markdown 文章放到 `src/content/blog/` 目录
3. `npm run build` 构建纯静态文件
4. 部署到 GitHub Pages，完全免费

## 写作体验

每篇文章就是一个 Markdown 文件：

```markdown
---
title: "文章标题"
date: "2026-05-22"
tags: ["标签"]
---

正文内容...
```

写完后 `git push`，网站自动更新。不需要数据库，不需要后台，简洁高效。

## 接下来

计划继续完善：

- 添加评论区（使用 Giscus，基于 GitHub Discussions）
- 优化 SEO
- 添加 RSS 订阅
- 设计更多个性化样式
