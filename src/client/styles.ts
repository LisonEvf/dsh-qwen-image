/**
 * 卡片 + 历史相册的自有样式。
 *
 * 只作用于本插件自己的 class（`qw-` 前缀），不改动全局主题。
 * 颜色优先使用主题 CSS 变量，缺失时回退到中性值，保证浅色/深色都可读。
 */

export const CARD_CSS = `
.qw-card {
  border: 1px solid var(--ds-border, rgba(127,127,127,.28));
  border-radius: 10px;
  padding: 10px 12px;
  margin: 6px 0;
  background: var(--ds-surface, rgba(127,127,127,.06));
  font-size: 13px;
  line-height: 1.5;
}
.qw-card--error { border-color: var(--ds-danger, #d9534f); }
.qw-card__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qw-card__title { font-weight: 600; }
.qw-card__meta { opacity: .72; font-size: 12px; }
.qw-card__prompt {
  margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  background: rgba(127,127,127,.09); white-space: pre-wrap; word-break: break-word;
}
.qw-card__hint { margin-top: 6px; font-size: 12px; opacity: .7; }

.qw-spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid rgba(127,127,127,.35);
  border-top-color: var(--ds-accent, #4a9eff);
  animation: qw-spin .8s linear infinite;
  display: inline-block; flex: none;
}
@keyframes qw-spin { to { transform: rotate(360deg); } }

.qw-progress {
  margin-top: 8px; height: 4px; border-radius: 2px;
  background: rgba(127,127,127,.2); overflow: hidden;
}
.qw-progress__bar {
  height: 100%; background: var(--ds-accent, #4a9eff);
  transition: width .6s ease;
}

.qw-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: rgba(127,127,127,.18);
}
.qw-badge--ok { background: rgba(60,180,110,.22); color: var(--ds-success, #2e9e63); }

.qw-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.qw-figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.qw-img {
  max-width: min(360px, 100%); max-height: 360px; border-radius: 8px;
  cursor: zoom-in; display: block; background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  border: 1px solid rgba(127,127,127,.22);
}
.qw-figcaption { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: .8; }
.qw-figcaption code { font-size: 11px; }

.qw-btn {
  font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px;
  border: 1px solid rgba(127,127,127,.32);
  background: rgba(127,127,127,.1); color: inherit; cursor: pointer;
}
.qw-btn:hover:not(:disabled) { background: rgba(127,127,127,.2); }
.qw-btn:disabled { opacity: .5; cursor: default; }
.qw-btn--mini { font-size: 11px; padding: 1px 7px; }
a.qw-btn { text-decoration: none; display: inline-block; }

/* 点图放大的灯箱（只有图片，没有面板） */
.qw-lightbox {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,.82);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; cursor: zoom-out; padding: 24px;
}
.qw-lightbox__img {
  max-width: 92vw; max-height: 82vh; object-fit: contain;
  border-radius: 8px; background: #fff;
}
.qw-lightbox__hint { color: rgba(255,255,255,.7); font-size: 12px; }
.qw-lightbox__actions { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
.qw-lightbox__panel { cursor: default; }

/* ══════════════════════════════════════════════════════════════════
   历史相册（conversation.view）
   回顾 + 管理：网格紧凑能一眼扫过去，筛选/排序/分组在顶部一行解决，
   改动（标签/提示词/收藏）就地生效，删除默认进回收站。
   ══════════════════════════════════════════════════════════════════ */
.qw-album {
  padding: 12px 16px 28px;
  overflow-y: auto;
  height: 100%;
  font-size: 13px;
  display: flex;
  flex-direction: column;
}

.qw-album__head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 10px; border-bottom: 1px solid rgba(127,127,127,.2);
  position: sticky; top: 0; z-index: 2;
  background: var(--ds-surface, transparent);
  backdrop-filter: blur(6px);
}
.qw-album__titlebox { display: flex; flex-direction: column; line-height: 1.2; }
.qw-album__title { margin: 0; font-size: 15px; font-weight: 600; }
.qw-album__sub { font-size: 11px; opacity: .6; }
.qw-album__search {
  flex: 1 1 160px; min-width: 120px; max-width: 320px;
  font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 7px;
  border: 1px solid rgba(127,127,127,.3);
  background: rgba(127,127,127,.08); color: inherit;
}
.qw-album__search:focus { outline: none; border-color: var(--ds-accent, #4a9eff); }
.qw-album__head > .qw-btn { margin-left: auto; }

.qw-album__grid {
  display: grid; gap: 10px; margin-top: 12px;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}

/* 网格瓦片：缩略图为方形容器，图按 cover 填充，扫视更整齐 */
.qw-tile {
  margin: 0; cursor: zoom-in;
  border: 1px solid rgba(127,127,127,.2); border-radius: 9px;
  overflow: hidden; display: flex; flex-direction: column;
  background: rgba(127,127,127,.05);
  transition: transform .12s ease, border-color .12s ease;
}
.qw-tile:hover { transform: translateY(-2px); border-color: rgba(127,127,127,.42); }
.qw-tile__img {
  width: 100%; aspect-ratio: 1; object-fit: cover; display: block;
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.qw-tile__cap { padding: 5px 7px; display: flex; flex-direction: column; gap: 2px; }
.qw-tile__prompt {
  font-size: 11px; opacity: .85;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.qw-tile__meta { font-size: 10px; opacity: .55; }

.qw-album__foot {
  margin-top: auto; padding-top: 12px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 11px; opacity: .7;
  border-top: 1px solid rgba(127,127,127,.15);
}
.qw-album__foot-item { font-variant-numeric: tabular-nums; }
.qw-album__foot-hint { margin-left: auto; opacity: .8; }

/* ── 表单控件（排序/分组/标签输入）────────────────────────────── */
.qw-field { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.qw-field__label { opacity: .6; }
.qw-select, .qw-input, .qw-textarea {
  font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 6px;
  border: 1px solid rgba(127,127,127,.3);
  background: rgba(127,127,127,.08); color: inherit;
}
.qw-select:focus, .qw-input:focus, .qw-textarea:focus {
  outline: none; border-color: var(--ds-accent, #4a9eff);
}
.qw-textarea { width: 100%; resize: vertical; line-height: 1.5; }
.qw-input--mini { font-size: 11px; padding: 1px 6px; }
.qw-btn--on { background: var(--ds-accent, #4a9eff); border-color: transparent; color: #fff; }
.qw-btn--danger { color: var(--ds-danger, #d9534f); border-color: rgba(217,83,79,.5); }
.qw-btn--danger:hover:not(:disabled) { background: rgba(217,83,79,.16); }
.qw-btn--ghost { opacity: .8; }

/* ── 筛选条（计数取全量口径）──────────────────────────────────── */
.qw-filters {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  padding: 8px 0 2px; font-size: 11px;
}
.qw-filters__label { opacity: .55; margin-right: 1px; }
.qw-filters__sep {
  width: 1px; height: 14px; margin: 0 4px;
  background: rgba(127,127,127,.28);
}
.qw-chip {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(127,127,127,.3);
  background: rgba(127,127,127,.07); color: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.qw-chip:hover { background: rgba(127,127,127,.18); }
.qw-chip--on {
  background: var(--ds-accent, #4a9eff); border-color: transparent; color: #fff;
}
.qw-chip__n { opacity: .7; font-variant-numeric: tabular-nums; }

/* ── 批量操作条 ───────────────────────────────────────────────── */
.qw-batch {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 8px; padding: 6px 9px; border-radius: 8px;
  background: rgba(74,158,255,.12);
  border: 1px solid rgba(74,158,255,.3);
}
.qw-batch__count { font-size: 11px; font-weight: 600; margin-right: auto; }

/* ── 分组（分类）──────────────────────────────────────────────── */
.qw-grp { margin-top: 14px; }
.qw-grp__head {
  margin: 0 0 6px; font-size: 12px; font-weight: 600;
  display: flex; align-items: baseline; gap: 8px;
  opacity: .9;
}
.qw-grp__count { font-size: 10px; font-weight: 400; opacity: .55; }

/* ── 瓦片上的状态与悬浮操作 ───────────────────────────────────── */
.qw-tile__wrap { position: relative; }
.qw-tile--sel { border-color: var(--ds-accent, #4a9eff); box-shadow: 0 0 0 2px rgba(74,158,255,.35); }
.qw-tile__star {
  position: absolute; top: 4px; left: 6px; font-size: 13px; line-height: 1;
  color: #f5c542; text-shadow: 0 1px 3px rgba(0,0,0,.6);
}
.qw-tile__flag {
  position: absolute; top: 4px; right: 6px; font-size: 11px;
  color: #fff; background: rgba(0,0,0,.45); border-radius: 4px; padding: 0 4px;
}
.qw-tile__check {
  position: absolute; bottom: 6px; right: 6px; width: 15px; height: 15px;
  cursor: pointer; accent-color: var(--ds-accent, #4a9eff);
}
.qw-tile__hover {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; gap: 4px; padding: 5px;
  background: linear-gradient(transparent, rgba(0,0,0,.62));
  opacity: 0; transition: opacity .12s ease;
}
.qw-tile:hover .qw-tile__hover, .qw-tile--sel .qw-tile__hover { opacity: 1; }
.qw-tile__hover .qw-btn {
  background: rgba(255,255,255,.9); color: #222; border-color: transparent;
}
.qw-tile__tags { display: flex; gap: 3px; flex-wrap: wrap; }
.qw-tag {
  font-style: normal; font-size: 10px; padding: 0 5px; border-radius: 999px;
  background: rgba(127,127,127,.2); display: inline-flex; align-items: center; gap: 2px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qw-tag--click { cursor: pointer; }
.qw-tag--click:hover { background: rgba(127,127,127,.34); }
.qw-tag--more { opacity: .6; }
.qw-tag__x {
  font: inherit; font-size: 11px; line-height: 1; border: none; background: none;
  color: inherit; cursor: pointer; opacity: .6; padding: 0 0 0 2px;
}
.qw-tag__x:hover { opacity: 1; }

/* ── 弹窗 / 回收站 / 提示 ─────────────────────────────────────── */
.qw-modal {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.qw-modal__box {
  background: var(--ds-surface, #1b1b1f); color: inherit;
  border: 1px solid rgba(127,127,127,.3); border-radius: 10px;
  padding: 14px 16px; min-width: 280px; max-width: 460px; width: 100%;
  box-shadow: 0 12px 40px rgba(0,0,0,.45);
  display: flex; flex-direction: column; gap: 8px;
  max-height: 82vh; overflow-y: auto;
}
.qw-modal__box--wide { max-width: 620px; }
.qw-modal__title { margin: 0; font-size: 14px; font-weight: 600; }
.qw-modal__msg { margin: 0; font-size: 12px; opacity: .72; line-height: 1.5; }
.qw-modal__actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.qw-modal__known { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; }
.qw-trash { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.qw-trash__row {
  display: grid; grid-template-columns: auto auto 1fr auto auto; gap: 6px;
  align-items: center; font-size: 11px;
  padding: 5px 6px; border-radius: 6px; background: rgba(127,127,127,.09);
}
.qw-trash__id { font-size: 11px; }
.qw-trash__meta { opacity: .6; white-space: nowrap; }
.qw-trash__prompt {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85;
}
.qw-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 10001; padding: 7px 14px; border-radius: 999px; font-size: 12px;
  background: rgba(20,20,24,.92); color: #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,.45);
}

/* 灯箱里的标签与备注 */
.qw-lightbox__tags {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  justify-content: center; margin-top: 8px; color: #fff;
}
.qw-lightbox__note { color: rgba(255,255,255,.8); font-size: 12px; text-align: center; }
`
