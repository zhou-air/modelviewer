/** 装配层：Project/Model/Version 选择（启动层）+ 3D/树/属性（查看层）。
 *
 * 与原版的分工变化（Phase C/F）：
 *   原：启动即 loadData('../data/processed/...') + load('../data/processed/model.glb')
 *   现：启动先显示 Model Selector；用户 Open 一个 ready 版本后，才按该版本的路径加载三份元数据与 GLB。
 * 3D、模型树、属性面板、工具条、工程导航的接线逻辑保持原样，只是从"启动时执行一次"
 * 变成"每次切换版本时执行一次"，并在切换前显式卸载上一个模型。
 */
import * as THREE from 'three';
import { loadData } from './js/data.js';
import { Model3D } from './js/viewer3d.js';
import { IssueController } from './js/issues.js';
import { ModelTree } from './js/tree.js';
import { PropsPanel } from './js/props.js';
import { AssetManager, bindImportModal } from './js/assetManager.js';
import { access } from './js/access.js';
import { fmtMm, MeasureGlyph } from './js/measurement.js';
import { CameraMath, CameraFrame, CrosshairVisibility } from './js/navigation/engineeringNavigation.js';
import { InputState, NavigationKey, normalizeWheelEvent } from './js/navigation/inputState.js';
import {
  NavigationDefaults, MouseSensitivityRadiansPerPixel, MaxPitchRadians, WORLD_UNITS_PER_METER,
  createDefaultSettings, validateOrDefault, NavigationSettingsStore,
} from './js/navigation/navigationSettings.js';
import { keyBindings, KEY_BINDING_DEFINITIONS } from './js/keyBindings.js';
import { AppearanceSettings, APPEARANCE_DEFAULTS, ENVIRONMENT_PRESETS } from './js/appearance.js';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const viewer = {
  ready: false, error: null, stats: {}, selected: null,
  current: null, starts: 0, switches: 0,
};
window.__viewer = viewer;
const appearanceSettings = new AppearanceSettings();

async function loadEnvironmentTextureOptions() {
  const select = el('apEnvironmentTexture');
  try {
    const response = await fetch('./assets/environments/manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    const textures = Array.isArray(manifest?.textures) ? manifest.textures : [];
    for (const item of textures) {
      const file = typeof item?.file === 'string' ? item.file.trim() : '';
      if (!/^[^/\\]+\.(?:jpe?g|png)$/i.test(file)) continue;
      const option = document.createElement('option');
      option.value = `assets/environments/${file}`;
      option.textContent = String(item.label || item.id || file);
      select.append(option);
    }
  } catch (error) {
    console.warn('[viewer] 环境贴图清单未加载：', error);
  }
  const saved = appearanceSettings.current.environmentTexture;
  if (saved && ![...select.options].some((option) => option.value === saved)) {
    const option = document.createElement('option');
    option.value = saved;
    option.textContent = `已保存（清单中不可用）`;
    select.append(option);
  }
  select.value = saved;
  syncAppearanceInputs();
}

const ORBIT_HINT = '<b>左键</b>旋转 · <b>右键</b>平移 · <b>滚轮</b>缩放 · <b>单击</b>选中 · '
  + '<b>Ctrl+单击</b>多选 · <b>F</b> 复位<br>'
  + '<b>F8</b> 或点工具条 <b>Game</b> 切换到工程导航 · 灰显节点 = TXT 中有但 RVM 未导出几何<br>'
  + '工具条 <b>测量</b>：射线固定从屏幕中心发出（左键 Surface · <b>C</b> Center · '
  + '<b>右键</b>/<b>Esc</b> 取消未完成的点）';
const GAME_HINT = '<b>F8</b> 开关工程导航 · 点击 3D 视图捕获鼠标（准星居中）· <b>W/S</b> 沿镜头水平投影前后 · '
  + '<b>A/D</b> 水平左右 · <b>Space</b> 升 / <b>Shift</b> 降 · <b>双击并按住 W</b> 加速 · '
  + '<b>滚轮</b> 缩放 · <b>左键</b> 选中准星对象 · <b>Ctrl+左键</b> 加入/移出多选 · '
  + '<b>左键点空处</b> 取消选中 · <b>右键</b> 打开已选模型的显隐/隔离菜单 · '
  + '准星指到的部件会浅蓝闪烁（预选中）· '
  + '<b>F</b> 复位到选中部件 · <b>Esc</b> 释放鼠标（模式不变）· 导航方式仅 <b>F8</b>/工具条切换<br>'
  + '工具条 <b>测量</b>：准星取点（<b>左键</b> Surface · <b>C</b> Center · <b>V</b> 连续测量 · '
  + '<b>右键</b>/<b>Esc</b> 取消未完成的点 · <b>Ctrl+Z</b> 撤销上一步 · <b>Delete</b> 删上一条）';

function setStatus(text, isErr, detail) {
  statusEl.classList.toggle('hidden', !text);
  statusEl.classList.toggle('err', !!isErr);
  if (text) statusEl.innerHTML = isErr
    ? `<b>失败</b><br>${text}${detail ? `<br><br><code>${detail}</code>` : ''}`
    : text;
}

// ---------------------------------------------------------------- 启动层

// 访问权限门：外网无 Session 时会阻塞在访问码输入页，登录成功后整页重载。
// 本机 (localhost) 由后端判定为 INTERNAL_NETWORK，直接进入，无感。
await access.init();

const am = new AssetManager({
  onOpen: openVersion,
  onResume: () => { el('viewerRoot').classList.remove('hidden'); },
});
bindImportModal(am);
viewer.am = am;                                     // 自动化测试用
access.applyChrome();                               // 角色徽标 / 今日内部码 / 权限裁剪
am.refresh();
am.show(false);                                     // 启动先显示 Model Selector，不自动加载任何模型

el('btnBack').onclick = () => backToLauncher();
el('btnImportTop').onclick = () => am.openImport(viewer.current || {});
bindKeyBindingsUI();

// ---------------------------------------------------------------- 面板显隐（左树默认开，右属性默认隐藏）

el('btnToggleTree').onclick = () => {
  const hidden = el('left').classList.toggle('hidden');
  el('btnToggleTree').classList.toggle('on', !hidden);
  model?.resize();
};
el('btnToggleProps').onclick = () => {
  const hidden = el('right').classList.toggle('hidden');
  el('btnToggleProps').classList.toggle('on', !hidden);
  model?.resize();
};

// ---------------------------------------------------------------- 树搜索（仅匹配名称，canonical 只作展示）

const searchInput = el('treeSearchInput');
const searchClear = el('treeSearchClear');
const searchResults = el('searchResults');
const treeBody = el('tree');
let searchTimer = null;
let treeOnPick = null;                               // openVersion 时指向当前版本的树→3D/属性联动回调

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function resetTreeSearch() {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  searchResults.innerHTML = '';
  searchResults.classList.add('hidden');
  treeBody.classList.remove('hidden');
}

function _searchShortLabel(o) {
  if (o.name) return o.name;
  const parts = o.canonical.split(' ');
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : o.canonical;
}

function runTreeSearch() {
  const q = searchInput.value.trim().toLowerCase();
  searchClear.classList.toggle('hidden', !searchInput.value);
  const closeResults = () => {
    searchResults.innerHTML = '';
    searchResults.classList.add('hidden');
    treeBody.classList.remove('hidden');
  };
  if (!q || !data) { closeResults(); return; }

  const hits = [];
  for (const [id, o] of Object.entries(data.objects)) {
    if ((o.name || '').toLowerCase().includes(q)) {  // 只按名称匹配，全路径不参与（避免元件名撞上别人的路径）
      hits.push([id, o]);
      if (hits.length >= 200) break;                 // 8955 个对象全扫也就毫秒级，但 DOM 只渲染前 100
    }
  }

  const frag = document.createDocumentFragment();
  const sum = document.createElement('div');
  sum.className = 'summary';
  sum.textContent = hits.length >= 200
    ? `匹配 200+ 个（显示前 100，请细化关键词）`
    : `匹配 ${hits.length} 个`;
  frag.appendChild(sum);
  for (const [id, o] of hits.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'hit';
    row.innerHTML = `<div>${escHtml(_searchShortLabel(o))}`
      + `<span class="tp">${escHtml(o.type || '')}</span></div>`
      + `<div class="path">${escHtml(o.canonical)}</div>`;
    row.onclick = () => {
      closeResults();
      tree.select(id);                               // 展开祖先 + 滚动到可见
      treeOnPick?.(id, o);                           // 与点击树行走同一套联动（3D 选中 / 属性面板）
    };
    frag.appendChild(row);
  }
  searchResults.innerHTML = '';
  searchResults.appendChild(frag);
  searchResults.classList.remove('hidden');
  treeBody.classList.add('hidden');
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runTreeSearch, 200);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runTreeSearch(); }
  if (e.key === 'Escape') { resetTreeSearch(); }
});
searchClear.onclick = () => { resetTreeSearch(); searchInput.focus(); };

/** 回到选择器：**不卸载**当前模型（场景留在后台，直接从"返回 Viewer"继续看不用重载）。
 *  真正需要释放显存的是"打开另一个版本"，那一步在 Model3D.load() 里先 unload()。 */
function backToLauncher() {
  if (model && model.navigationMode === 'game') model.setNavigationMode('orbit');
  viewer.launcherOpen = true;
  el('viewerRoot').classList.add('hidden');
  am.refresh();
  am.show(!!model);
}

// ---------------------------------------------------------------- 查看层（懒创建，只建一次）

let issues = null, issueContextPoint = null;
let model = null, tree = null, props = null, data = null;
loadEnvironmentTextureOptions();
const gameCtxMenu = el('gameCtxMenu');
const gameColorSubmenu = el('gameColorSubmenu');
const gameColorPicker = el('gameColorPicker');

function closeGameContextMenu() {
  gameCtxMenu.classList.remove('on');
  gameColorSubmenu?.classList.remove('on');
}
function openGameContextMenu(point = {}) {
  if (!model?.selectedCanonicals.length || !viewer.ready) return;
  issueContextPoint = point;
  gameCtxMenu.querySelector('[data-action="add-issue"]').disabled = !access.isInternal;
  const x = Number.isFinite(point.clientX) && point.clientX > 0 ? point.clientX : innerWidth / 2;
  const y = Number.isFinite(point.clientY) && point.clientY > 0 ? point.clientY : innerHeight / 2;
  gameCtxMenu.classList.add('on');
  gameCtxMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - gameCtxMenu.offsetWidth - 8))}px`;
  gameCtxMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - gameCtxMenu.offsetHeight - 8))}px`;
}
gameCtxMenu.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  const action = button?.dataset.action;
  if (!action || !model) return;
  if (action === 'add-issue') { closeGameContextMenu(); issues?.begin(issueContextPoint); return; }
  if (action === 'color-open') {
    gameColorSubmenu?.classList.toggle('on');
    return;
  }
  if (action === 'color-preset') {
    model.setObjectColor(model.selectedCanonicals, button.dataset.color);
    closeGameContextMenu();
    return;
  }
  if (action === 'color-custom') {
    gameColorPicker?.click();
    return;
  }
  if (action === 'color-reset') {
    model.clearSelectedObjectColor();
    closeGameContextMenu();
    return;
  }
  if (action === 'hide') model.hideSelected();
  if (action === 'isolate') model.isolateSelected();
  if (action === 'show-all') model.showAll();
  closeGameContextMenu();
  refreshButtons();
});
gameColorPicker?.addEventListener('input', () => {
  if (!model || !model.selectedCanonicals.length) return;
  model.setObjectColor(model.selectedCanonicals, gameColorPicker.value);
  closeGameContextMenu();
});
document.addEventListener('pointerdown', (e) => {
  if (gameCtxMenu.classList.contains('on') && !gameCtxMenu.contains(e.target)) closeGameContextMenu();
}, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGameContextMenu(); });

function ensureViewer() {
  if (model) return;
  model = new Model3D(el('cv'), {
    appearance: appearanceSettings.current,
    onSelect: (canonical, opts = {}) => {
      viewer.selected = canonical;                   // 主选中（最后加入的那个），单值语义保持
      const canonicals = model.selectedCanonicals;
      viewer.selectedCanonicals = canonicals;
      // 树与 3D 共用同一份选择集：Ctrl 多选无论从哪一侧发起，两侧高亮都一致。
      // 不加这一步的话，3D 侧 Ctrl 多选或"点空处清空"都会让树停留在旧状态。
      const ids = canonicals.map((c) => data?.idOf(c)).filter(Boolean);
      const txtId = canonical && data ? data.idOf(canonical) : null;
      tree?.setSelection(ids, { primary: txtId, scroll: !opts.additive });
      if (canonical) {
        // txtId 可能为空（GLB 有节点、TXT 没这个对象）：属性面板清空，但徽标仍显示 canonical
        if (txtId) props.show(txtId); else props.clear();
        el('selBadge').classList.add('on');
        el('selName').textContent = canonicals.length > 1
          ? `${canonical}（共 ${canonicals.length} 个对象 · Ctrl+点击增删）`
          : canonical;
      } else {
        props.clear();
        el('selBadge').classList.remove('on');
      }
      refreshButtons();
    },
    onReady: (info) => {
      viewer.modelInfo = info;
      setStatus('');
    viewer.ready = true;
      if (viewer.__t0) viewer.timings.readyMs = Math.round(performance.now() - viewer.__t0);
      refreshButtons();
      // 模型就绪后才知道有没有 rvmparser-origin（决定测距按 PDMS 还是 GLB 轴向展示），
      // 这里补一次回显，不然面板会停在加载前的默认文案上
      syncMeasurePanel();
      syncAppearanceInputs();
    },
    onNavigationState: (state) => applyNavigationState(state),
    onMeasurementChange: (state) => syncMeasurePanel(state),
    onGameContextMenu: (point) => openGameContextMenu(point),
    // 测量点命名：复用既有的 canonicalId → metadata 映射（data.idOf / objects[].name），
    // 不为显示名称重新解析模型。取不到名称就返回 null，由测量层退回 P 编号。
    resolvePointName: (canonical) => {
      const id = canonical && data ? data.idOf(canonical) : null;
      const name = id ? data.objects[id]?.name : null;
      return name ? String(name).trim() : null;
    },
  });
  issues = new IssueController(model);
  viewer.issues = issues;
  el('cv').addEventListener('contextmenu', (e) => {
    if (model.navigationMode !== 'orbit') return;
    e.preventDefault();
    openGameContextMenu(e);
  });
  model.onStats = (s) => {
    viewer.stats = s;
    el('sFps').textContent = s.fps;
    el('sCalls').textContent = s.drawCalls;
    el('sTris').textContent = s.triangles.toLocaleString();
    el('sVis').textContent = s.hidden ? `${s.visible} （隐 ${s.hidden}）` : s.visible;
    el('sAll').textContent = s.frameDrawCallsAllPasses;
    el('sFrame').textContent = `${s.frameTimeMs.toFixed(2)} ms`;
    el('sCpu').textContent = `${s.cpuFrameTimeMs.toFixed(2)} ms`;
    el('sGpu').textContent = s.gpuFrameTimeMs == null
      ? `N/A (${s.gpuTimerStatus})` : `${s.gpuFrameTimeMs.toFixed(2)} ms`;
    el('sRenderables').textContent = `${s.visibleMeshes} / ${s.visibleLines}`;
    el('sGraphics').textContent = s.renderer;
    el('sWebgl').textContent = s.webgl;
    el('sResolution').textContent = `${s.resolution} @ ${s.pixelRatio.toFixed(2)}x`;
    el('sEffects').textContent = `${s.outlineEnabled ? '开' : '关'} / ${s.contours ? '开' : '关'}`;
  };
  viewer.__model = model;
  bindToolbar();
}

function refreshButtons() {
  const has3d = !!viewer.selected;
  el('btnHide').disabled = !has3d;
  el('btnIsolate').disabled = !has3d;
  el('btnShowAll').disabled = !model || model.hiddenCount === 0;
}

function bindToolbar() {
  el('btnFit').onclick = () => model.fit(model.selectedCanonicals);
  el('btnHide').onclick = () => { if (model.hideSelected()) refreshButtons(); };
  el('btnIsolate').onclick = () => { if (model.isolateSelected()) refreshButtons(); };
  el('btnShowAll').onclick = () => { model.showAll(); refreshButtons(); };
  el('btnFloorPlan').onclick = () => {
    model.setFloorPlanVisible(!model.floorPlanState().visible);
    syncFloorPlanInputs();
  };

  el('navOrbit').onclick = () => model.setNavigationMode('orbit');
  el('navGame').onclick = () => model.setNavigationMode('game');
  el('btnNavSettings').onclick = () => {
    el('navSettings').classList.toggle('on');
    el('keyBindingsPanel').classList.remove('on');
    el('appearance').classList.remove('on');   // 两个设置面板都贴在右下角，不能同时开
    setMeasurePanel(false);                    // 测量面板同位置，一并让位
    syncNavSettingsInputs();
  };
  el('nsClose').onclick = () => el('navSettings').classList.remove('on');
  el('nsReset').onclick = () => { model.navigationSettings.reset(); syncNavSettingsInputs(); };
  el('nsSpeed').addEventListener('change', applyNavSettingsFromInputs);
  el('nsSprint').addEventListener('change', applyNavSettingsFromInputs);

  el('btnAppearance').onclick = () => {
    el('appearance').classList.toggle('on');
    el('navSettings').classList.remove('on');
    el('keyBindingsPanel').classList.remove('on');
    setMeasurePanel(false);
    syncAppearanceInputs();
  };
  el('apClose').onclick = () => el('appearance').classList.remove('on');
  el('apContours').addEventListener('change', () => {
    model.setContours(el('apContours').checked);
  });
  el('apXray').addEventListener('change', () => {
    model.setXray(el('apXray').checked);
    syncAppearanceInputs();
  });
  el('apOpacity').addEventListener('input', () => {
    model.setXrayOpacity(Number(el('apOpacity').value) / 100);
    syncAppearanceInputs();
  });
  el('apFloorDebug').addEventListener('change', () => {
    model.setFloorPlanDebug(el('apFloorDebug').checked);
    syncFloorPlanInputs();
  });
  el('apGlobalColor').addEventListener('input', () => {
    const value = model.setGlobalModelColor(el('apGlobalColor').value);
    appearanceSettings.patch({ globalModelColor: value });
    syncAppearanceInputs();
  });
  el('apGlobalReset').onclick = () => {
    const value = model.setGlobalModelColor(APPEARANCE_DEFAULTS.globalModelColor);
    appearanceSettings.patch({ globalModelColor: value });
    syncAppearanceInputs();
  };
  el('apBackgroundColor').addEventListener('input', () => {
    const value = model.setBackgroundColor(el('apBackgroundColor').value);
    appearanceSettings.patch({ backgroundColor: value });
    syncAppearanceInputs();
  });
  el('apEnvironmentMode').addEventListener('change', () => {
    const environmentMode = el('apEnvironmentMode').value;
    appearanceSettings.patch({ environmentMode });
    model.setEnvironmentMode(environmentMode).finally(syncAppearanceInputs);
    syncAppearanceInputs();
  });
  el('apEnvironmentPreset').addEventListener('change', () => {
    const environmentPreset = el('apEnvironmentPreset').value;
    if (environmentPreset === 'custom') return;
    const { label, ...environmentColors } = ENVIRONMENT_PRESETS[environmentPreset];
    appearanceSettings.patch({ environmentPreset, environmentColors });
    model.setEnvironmentPreset(environmentPreset);
    syncAppearanceInputs();
  });
  el('apEnvironmentTexture').addEventListener('change', () => {
    const environmentTexture = el('apEnvironmentTexture').value;
    appearanceSettings.patch({ environmentTexture });
    model.setEnvironmentTexture(environmentTexture).finally(syncAppearanceInputs);
    syncAppearanceInputs();
  });
  for (const id of ['apSkyColor', 'apHorizonColor', 'apGroundFarColor']) {
    el(id).addEventListener('input', () => {
      const current = appearanceSettings.current.environmentColors;
      const environmentColors = {
        ...current,
        skyTopColor: el('apSkyColor').value,
        skyHorizonColor: el('apHorizonColor').value,
        groundHorizonColor: el('apHorizonColor').value,
        groundFarColor: el('apGroundFarColor').value,
      };
      appearanceSettings.patch({ environmentPreset: 'custom', environmentColors });
      model.setEnvironmentColors(environmentColors);
      syncAppearanceInputs();
    });
  }
  for (const [id, key, slider] of [
    ['apLightingEnabled', 'lightingEnabled', false], ['apLightingIntensity', 'lightingIntensity', true],
    ['apAoEnabled', 'aoEnabled', false], ['apAoIntensity', 'aoIntensity', true],
    ['apAoRadius', 'aoRadius', true],
  ]) {
    el(id).addEventListener(slider ? 'input' : 'change', () => {
      const value = slider ? Number(el(id).value) / 100 : el(id).checked;
      model.setLightingAppearance(appearanceSettings.patch({ [key]: value }));
      syncAppearanceInputs();
    });
  }
  el('apGround').addEventListener('change', () => {
    const value = model.setGroundEnabled(el('apGround').checked);
    appearanceSettings.patch({ groundEnabled: value });
    syncAppearanceInputs();
  });
  el('apGroundColor').addEventListener('input', () => {
    const value = model.setGroundColor(el('apGroundColor').value);
    appearanceSettings.patch({ groundColor: value });
    syncAppearanceInputs();
  });
  el('apFloorPlan').addEventListener('change', () => {
    model.setFloorPlanVisible(el('apFloorPlan').checked);
    syncAppearanceInputs();
    syncFloorPlanInputs();
  });
  el('apReset').onclick = () => {
    const settings = appearanceSettings.reset();
    model.applyUserAppearance(settings);
    model.resetTransientAppearance();
    syncAppearanceInputs();
    syncFloorPlanInputs();
  };

  el('btnMeasure').onclick = () => {
    // 开启测量顺手把面板打开；关闭测量顺手收起面板（结果仍会保留，重新打开即可查看）
    const on = model.toggleMeasurement();
    setMeasurePanel(on);
    syncMeasurePanel();
  };
  el('measureClose').onclick = () => setMeasurePanel(false);
  el('measureClear').onclick = () => { model.clearMeasurements(); syncMeasurePanel(); };
  el('measureXyz').addEventListener('change', () => {
    model.setMeasureComponents(el('measureXyz').checked);
    syncMeasurePanel();
  });
  el('measureCopy').onclick = () => copyMeasurements();

  syncNavSettingsInputs();
  syncAppearanceInputs();
  syncFloorPlanInputs();
  syncMeasurePanel();
  applyNavigationState(model.navigationState());
}

function bindKeyBindingsUI() {
  el('btnKeyBindings').onclick = () => {
    el('keyBindingsPanel').classList.toggle('on');
    el('navSettings').classList.remove('on'); el('appearance').classList.remove('on'); setMeasurePanel(false);
    renderKeyBindings();
  };
  el('keyBindingsClose').onclick = () => el('keyBindingsPanel').classList.remove('on');
  el('keyBindingsReset').onclick = () => { keyBindings.reset(); renderKeyBindings(); };
}

function renderKeyBindings() {
  const root = el('keyBindingsRows'); root.innerHTML = ''; let group = '';
  for (const def of KEY_BINDING_DEFINITIONS) {
    if (def.group !== group) { group = def.group; root.insertAdjacentHTML('beforeend', `<h4>${def.group}</h4>`); }
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label>${def.label}</label><button class="key-binding" type="button">${keyBindings.get(def.id)}</button>`;
    row.lastElementChild.onclick = () => {
      const button = row.lastElementChild; button.textContent = '请按键…';
      const listen = (event) => { event.preventDefault(); event.stopPropagation(); const result = keyBindings.set(def.id, event.code); window.removeEventListener('keydown', listen, true); if (!result.ok) alert('键位冲突，未修改。'); renderKeyBindings(); };
      window.addEventListener('keydown', listen, true);
    };
    root.appendChild(row);
  }
}

// ------------------------------------------------ 游戏式测距（面板回显）

let measurePanelOpen = false;
let measureRenderedRevision = -1;
let measureNowCache = '';

/** 右下角三个面板（导航设置 / 外观 / 测量）同位置，互斥显示 */
function setMeasurePanel(open) {
  measurePanelOpen = !!open;
  el('measurePanel').classList.toggle('on', measurePanelOpen);
  if (measurePanelOpen) {
    el('navSettings').classList.remove('on');
    el('appearance').classList.remove('on');
    el('keyBindingsPanel').classList.remove('on');
  }
}

const measureRowHtml = (r, live) => `<div class="kv2">
      <span class="k">Direct Distance</span><span class="v hi">${fmtMm(r.distanceMm)}</span>
      <span class="k">ΔX</span><span class="v">${fmtMm(r.dxMm)}</span>
      <span class="k">ΔY</span><span class="v">${fmtMm(r.dyMm)}</span>
      <span class="k">ΔZ</span><span class="v">${fmtMm(r.dzMm)}</span>
      <span class="k">Horizontal Distance</span><span class="v">${fmtMm(r.horizontalMm)}</span>
    </div>`;

/** 复制测量结果到剪贴板。
 *  上下文：本机 localhost 是安全上下文可用 Clipboard API，但局域网 http://192.168.x.x 不是，
 *  `navigator.clipboard` 会是 undefined —— 所以失败时退化到 textarea + execCommand('copy')，
 *  两者都失败才给明确提示（不静默失败）。 */
async function copyMeasurements() {
  if (!model) return false;
  const text = model.measurementClipboardText();
  if (!text || !model.measurementState().measurements.length) {
    am.toast('还没有测量结果可复制', 'err');
    return false;
  }
  let via = null;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      via = 'clipboard';
    }
  } catch (e) { via = null; }
  if (!via) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    via = ok ? 'execCommand' : null;
  }
  if (!via) {
    am.toast('复制失败：浏览器拒绝了剪贴板写入。请用 https 或 localhost 打开本页，或手动从面板抄录。', 'err');
    return false;
  }
  const n = model.measurementState().measurements.length;
  am.toast(`已复制 ${n} 条测量结果（TAB 分隔），可直接粘贴进 Excel`);
  return true;
}

/** 测量状态 → 面板。实时区每次变化都刷新（内容相同时不写 DOM）；
 *  结果列表只在"测量集合变化"（revision 自增）时重建，避免 30 Hz 重建 DOM。 */
function syncMeasurePanel(state) {
  if (!model) return;
  const s = state || model.measurementState();
  el('btnMeasure').classList.toggle('on', s.enabled);
  el('measureAxes').textContent = s.axes === 'PDMS_WORLD_Z_UP'
    ? 'PDMS 世界坐标（Z 向上）'
    : 'GLB 坐标（Y 向上，本版本未取到 rvmparser-origin）';
  el('measureClear').disabled = !s.measurements.length && !s.pending;
  el('measureCopy').disabled = s.measurements.length === 0;
  el('measureXyz').checked = s.showComponents;

  let now = s.aim
    ? `命中 <b>${escHtml(s.aim.canonicalId)}</b>`
    : '未命中模型（准星指向空白）';
  if (s.continuous) {
    now += ' · <b>连续测量中</b>（V 关闭）';
  }
  if (s.pending) {
    now += `<br>已取 A（${s.pending.kind === 'center' ? '对象中心 ◎' : '表面点 ⊕'}）`
      + `：<b>${escHtml(s.pending.displayName || '')}</b>`
      + `　${escHtml(s.pending.canonicalId || '')} · `
      + (s.continuous ? '下一点自动接续（右键/Esc 断开）' : '再取一次固定 B');
  } else if (s.enabled) {
    now += '<br>左键取表面点（⊕）· C 取对象中心（◎）· V 连续测量';
  }
  if (s.pendingResult) now += `<br>${measureRowHtml(s.pendingResult, true)}`;
  if (now !== measureNowCache) {
    measureNowCache = now;
    el('measureNow').innerHTML = now;
  }

  if (s.revision !== measureRenderedRevision) {
    measureRenderedRevision = s.revision;
    el('measureList').innerHTML = s.measurements.length
      ? s.measurements.map((m, i) => {
        const r = m.record || {};
        const title = `A ${escHtml(m.a.canonicalId || '')} → B ${escHtml(m.b.canonicalId || '')}`;
        return `<div class="mitem">
      <div class="mh"><b>#${i + 1}</b><span title="${title}">${escHtml(r.from || '')} → ${escHtml(r.to || '')}</span></div>
      ${measureRowHtml(m.result, false)}
    </div>`;
      }).join('')
      : '<div class="mempty">还没有测量结果。开启测量后：左键取 A → 移动准星 → 再左键（或 C）取 B。</div>';
  }
}

// ------------------------------------------------ 外观选项（元件轮廓线 / 隐藏件半透明）

/** 只负责界面回显：真实状态始终以 Model3D 为准（面板可能从没打开过） */
function syncAppearanceInputs() {
  if (!model) return;
  const a = model.appearanceState();
  el('apLightingEnabled').checked = a.lightingEnabled;
  el('apAoEnabled').checked = a.aoEnabled;
  el('apAoRadius').value = Math.round(a.aoRadius * 100);
  el('apAoRadiusVal').textContent = `${Math.round(a.aoRadius * 100)} cm`;
  el('apAoRadius').disabled = !a.aoEnabled;
  for (const [id, value, enabled] of [
    ['apLightingIntensity', a.lightingIntensity, a.lightingEnabled],
    ['apAoIntensity', a.aoIntensity, a.aoEnabled],
  ]) {
    el(id).value = Math.round(value * 100);
    el(id + 'Val').textContent = `${Math.round(value * 100)}%`;
    el(id).disabled = !enabled;
    el(id).closest('.row').classList.toggle('off', !enabled);
  }
  el('apGlobalColor').value = a.globalModelColor;
  el('apBackgroundColor').value = a.backgroundColor;
  el('apEnvironmentMode').value = a.environmentMode;
  el('apEnvironmentPreset').value = a.environmentPreset;
  el('apEnvironmentTexture').value = a.environmentTexture;
  el('apSkyColor').value = a.environmentColors.skyTopColor;
  el('apHorizonColor').value = a.environmentColors.skyHorizonColor;
  el('apGroundFarColor').value = a.environmentColors.groundFarColor;
  const solid = a.environmentMode === 'solid';
  const horizon = a.environmentMode === 'horizon';
  const texture = a.environmentMode === 'texture';
  for (const [id, enabled] of [
    ['apBackgroundColorRow', solid], ['apEnvironmentPresetRow', horizon],
    ['apEnvironmentTextureRow', texture], ['apEnvironmentAdvanced', horizon],
  ]) el(id).classList.toggle('off', !enabled);
  el('apBackgroundColor').disabled = !solid;
  el('apEnvironmentPreset').disabled = !horizon;
  el('apEnvironmentTexture').disabled = !texture;
  for (const id of ['apSkyColor', 'apHorizonColor', 'apGroundFarColor']) el(id).disabled = !horizon;
  el('apEnvironmentStatus').textContent = texture
    ? (a.environmentStatus === 'loading' ? '正在加载当前贴图…'
      : (a.environmentError || '贴图仅用于背景，不影响模型光照与反射。'))
    : (a.environmentMode === 'silver-rain' ? '黑色背景上的银色线条持续向下循环。' : '环境与 Ground Plane、FloorPlan 相互独立。');
  el('apGround').checked = a.groundEnabled;
  el('apGroundColor').value = a.groundColor;
  el('apGroundColor').disabled = !a.groundEnabled;
  el('apGroundColorRow').classList.toggle('off', !a.groundEnabled);
  el('apContours').checked = a.contours;
  el('apXray').checked = a.xray;
  el('apOpacity').value = Math.round(a.xrayOpacity * 100);
  el('apOpacityVal').textContent = `${Math.round(a.xrayOpacity * 100)}%`;
  // 半透明关着时"不透明度"没有作用对象 → 灰显；但保留调过的值，下次打开还是它
  el('apOpacityRow').classList.toggle('off', !a.xray);
  el('apOpacity').disabled = !a.xray;
  el('apFloorPlan').checked = model.floorPlanState().visible;
}

function syncFloorPlanInputs() {
  if (!model) return;
  const s = model.floorPlanState();
  el('btnFloorPlan').classList.toggle('on', s.visible && s.available);
  el('btnFloorPlan').disabled = !s.available;
  el('btnFloorPlan').title = s.available
    ? `显示 / 隐藏只读设备定位底图（${s.stats?.positioned ?? 0} 个定位点）`
    : (s.error ? `设备定位图不可用：${s.error}` : '当前版本没有 floorplan.json');
  el('apFloorDebug').checked = s.debug;
  el('apFloorDebug').disabled = !s.available;
  el('apFloorDebugRow').classList.toggle('off', !s.available);
  el('apFloorPlan').checked = s.visible;
  el('apFloorPlan').disabled = !s.available;
  el('apFloorPlanRow').classList.toggle('off', !s.available);
}

function applyNavigationState(s) {
  viewer.nav = s;
  el('navOrbit').classList.toggle('on', s.mode === 'orbit');
  el('navGame').classList.toggle('on', s.mode === 'game');
  el('crosshair').classList.toggle('on', !!s.crosshair);
  el('hint').innerHTML = s.mode === 'game' ? GAME_HINT : ORBIT_HINT;
  const prompt = !s.failure && s.mode === 'game' && !s.captured;
  el('navPrompt').classList.toggle('on', prompt);
  el('navPrompt').innerHTML = s.failure
    ? `无法进入工程导航：${s.failure}`
    : (s.paused
      ? '已暂停（窗口失去焦点）—— 再次点击 3D 视图恢复鼠标捕获'
      : '点击 3D 视图捕获鼠标 · <b>F8</b> 或工具条切换导航方式');
}

function syncNavSettingsInputs() {
  const s = model.navigationSettings.current;
  el('nsSpeed').value = s.normalSpeedMetersPerSecond;
  el('nsSprint').value = s.sprintMultiplier;
}

function applyNavSettingsFromInputs() {
  model.navigationSettings.save({
    schemaVersion: 1,
    normalSpeedMetersPerSecond: Number(el('nsSpeed').value),
    sprintMultiplier: Number(el('nsSprint').value),
  });
  syncNavSettingsInputs();
}

// ---------------------------------------------------------------- 打开某个版本

function setTitle(ctx) {
  el('curProject').textContent = ctx.project.name;
  el('curModel').textContent = ctx.model.name;
  el('curVersion').textContent = ctx.version.name;
  document.title = `${ctx.project.name} / ${ctx.model.name} / ${ctx.version.name} — PDMS Viewer`;
  el('curMeta').textContent = `RVM ${(ctx.version.rvmBytes / 1048576).toFixed(1)} MB`
    + ` · GLB ${(ctx.version.glbBytes / 1048576).toFixed(1)} MB`;
}

async function openVersion(ctx) {
  const { project, model: mdl, version } = ctx;
  viewer.starts += 1;
  if (viewer.starts > 1) viewer.switches += 1;
  viewer.__t0 = performance.now();
  viewer.ready = false;
  viewer.current = {
    projectId: project.id, modelId: mdl.id, versionId: version.id,
    projectName: project.name, modelName: mdl.name, versionName: version.name,
    glb: version.assets.glb, base: version.assets.glb.replace(/\/[^/]+$/, ''),
  };
  el('viewerRoot').classList.remove('hidden');
  ensureViewer();
  issues.clear();
  closeGameContextMenu();
  model.setNavigationMode('orbit');                  // 换模型前退出游戏导航
  setTitle(ctx);

  const base = viewer.current.base;
  const tModelStart = performance.now();
  try {
    setStatus('正在加载元数据… <span id="pct">0%</span>');
    const tJson = performance.now();
    data = await loadData({
      base,
      floorPlanUrl: version.assets.floorplan || null,
      onProgress: (got, total, key) => {
        const pctEl = el('pct');
        if (pctEl && total) {
          pctEl.textContent = `${key || ''} ${Math.round(got / total * 100)}%`;
        }
      },
    });
    viewer.timings = { ...(data.timings || {}) };
    viewer.dataStats = data.stats;
    viewer.data = data;                              // 供实测脚本读取 mapping/objects/idOf
  } catch (e) {
    viewer.error = '元数据加载失败：' + e.message;
    setStatus(viewer.error, true, `版本 ${version.name} 的 processed/ 产物缺失或不完整。`
      + '请用左下角「切换模型」返回，重新导入该版本。');
    return;
  }

  // 树与属性面板：首次创建，之后只换数据源（避免在 host 上叠加监听）
  const onPick = (txtId, o, opts = {}) => {
    const has3d = data.geomOf.has(o.canonical);
    // additive：树内 Ctrl+点击。加入 = 追加进选择集；移出 = 同一 toggle 语义关掉它。
    // 无几何的行（3D 里不存在）用 additive 调用时 select 会直接返回，不会清掉已有选择集。
    model.select(has3d ? o.canonical : null, { additive: !!opts.additive });
    if (!has3d) {
      props.show(txtId);
      el('selBadge').classList.remove('on');
      // 普通点击无几何的行：3D 选择集为空 → 上面的镜像会把树的选择态清掉，这里按树的原意补回该行
      if (!opts.additive) tree.setSelection([txtId], { primary: txtId, scroll: false });
    }
    refreshButtons();
  };
  treeOnPick = onPick;                               // 树搜索结果点击时复用同一套联动
  if (!tree) {
    tree = new ModelTree(el('tree'), data, { onPick });
    props = new PropsPanel(el('props'), el('propInfo'), data);
  } else {
    tree.setData(data);
    props.setData(data);
  }
  viewer.__treeRows = tree.rows;

  el('treeInfo').textContent =
    `${data.stats.objects.toLocaleString()} 个对象 · ${data.stats.maxDepth + 1} 层 · `
    + `几何对应 ${data.mapping.stats.matched.toLocaleString()} · 点 ▸ 展开 · Ctrl+点击可多选`;
  resetTreeSearch();                                 // 换版本后上一版的搜索词与结果作废

  // 状态重置：不把上一版本的选中/隐藏/隔离带到这一版
  model.selected = null;
  model.outline.selectedObjects = [];
  model.hiddenCanonicals.clear();
  el('selBadge').classList.remove('on');
  props.clear();
  refreshButtons();

  setStatus('正在加载模型… <span id="pct">0%</span>');
  try {
    await model.load(version.assets.glb, (evt) => {
      const pctEl = el('pct');
      if (pctEl && evt.lengthComputable) {
        pctEl.textContent = `${Math.round(evt.loaded / evt.total * 100)}%`;
      }
    }, { floorplan: data.floorplan });
    await issues.bind(viewer.current, data, tree);
    viewer.timings.modelLoadMs = Math.round(performance.now() - tModelStart);
    model.resize();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    viewer.timings.firstFrameMs = Math.round(performance.now() - viewer.__t0);
    refreshButtons();
    syncAppearanceInputs();
    syncFloorPlanInputs();
  } catch (e) {
    viewer.error = '模型加载失败：' + e.message;
    setStatus(viewer.error, true, `请确认 ${version.assets.glb} 存在（用「切换模型」返回后重新导入）。`);
    syncFloorPlanInputs();
    syncAppearanceInputs();
  }
}

// ---------------------------------------------------------------- 供自动化实测使用的接口

viewer.select = (c) => model.select(c);
/** 追加/移出选择集（等价 Ctrl+点击）；用于实测驱动同一条生产路径 */
viewer.selectAdditive = (c) => model.select(c, { additive: true });
viewer.selectionState = () => model.selectionState();
viewer.hoverState = () => model.hoverState();
viewer.hide = () => { model.hideSelected(); refreshButtons(); };
viewer.isolate = () => { model.isolateSelected(); refreshButtons(); };
viewer.showAll = () => { model.showAll(); refreshButtons(); };

// 外观选项：与面板走同一条生产路径（都落在 Model3D 上），再回写界面
viewer.appearanceState = () => model.appearanceState();
for (const key of ['lightingEnabled', 'lightingIntensity', 'aoEnabled', 'aoIntensity', 'aoRadius']) {
  viewer['set' + key[0].toUpperCase() + key.slice(1)] = value => {
    const settings = appearanceSettings.patch({ [key]: value });
    model.setLightingAppearance(settings); syncAppearanceInputs(); return settings[key];
  };
}
viewer.setContours = (v) => { const r = model.setContours(v); syncAppearanceInputs(); return r; };
viewer.setXray = (v) => { const r = model.setXray(v); syncAppearanceInputs(); return r; };
viewer.setXrayOpacity = (v) => { const r = model.setXrayOpacity(v); syncAppearanceInputs(); return r; };
viewer.setGlobalModelColor = (v) => {
  const r = model.setGlobalModelColor(v); appearanceSettings.patch({ globalModelColor: r });
  syncAppearanceInputs(); return r;
};
viewer.setBackgroundColor = (v) => {
  const r = model.setBackgroundColor(v); appearanceSettings.patch({ backgroundColor: r });
  syncAppearanceInputs(); return r;
};
viewer.setEnvironmentMode = (v) => {
  appearanceSettings.patch({ environmentMode: v });
  const r = model.setEnvironmentMode(v); r.finally(syncAppearanceInputs); syncAppearanceInputs(); return r;
};
viewer.setEnvironmentPreset = (v) => {
  const preset = ENVIRONMENT_PRESETS[v];
  if (!preset) return false;
  const { label, ...environmentColors } = preset;
  appearanceSettings.patch({ environmentPreset: v, environmentColors });
  model.setEnvironmentPreset(v); syncAppearanceInputs(); return true;
};
viewer.setEnvironmentColors = (v) => {
  const settings = appearanceSettings.patch({ environmentPreset: 'custom', environmentColors: v });
  model.setEnvironmentColors(settings.environmentColors); syncAppearanceInputs(); return settings.environmentColors;
};
viewer.setEnvironmentTexture = async (v) => {
  appearanceSettings.patch({ environmentTexture: v });
  const r = await model.setEnvironmentTexture(v); syncAppearanceInputs(); return r;
};
viewer.setGroundEnabled = (v) => {
  const r = model.setGroundEnabled(v); appearanceSettings.patch({ groundEnabled: r });
  syncAppearanceInputs(); return r;
};
viewer.setGroundColor = (v) => {
  const r = model.setGroundColor(v); appearanceSettings.patch({ groundColor: r });
  syncAppearanceInputs(); return r;
};
viewer.setObjectColor = (v) => model.setObjectColor(model.selectedCanonicals, v);
viewer.clearSelectedObjectColor = () => model.clearSelectedObjectColor();
viewer.objectColorState = () => model.objectColorState();
viewer.resetAppearance = () => {
  const settings = appearanceSettings.reset();
  model.applyUserAppearance(settings);
  model.resetTransientAppearance();
  syncAppearanceInputs(); syncFloorPlanInputs();
  return model.appearanceState();
};
viewer.floorPlanState = () => model.floorPlanState();
viewer.setFloorPlanVisible = (v) => { const r = model.setFloorPlanVisible(v); syncFloorPlanInputs(); return r; };
viewer.setFloorPlanDebug = (v) => { const r = model.setFloorPlanDebug(v); syncFloorPlanInputs(); return r; };
viewer.appearanceUi = () => ({
  panelOpen: el('appearance').classList.contains('on'),
  navPanelOpen: el('navSettings').classList.contains('on'),
  globalColor: el('apGlobalColor').value,
  backgroundColor: el('apBackgroundColor').value,
  environmentMode: el('apEnvironmentMode').value,
  environmentPreset: el('apEnvironmentPreset').value,
  environmentTexture: el('apEnvironmentTexture').value,
  environmentStatus: el('apEnvironmentStatus').textContent,
  groundChecked: el('apGround').checked,
  groundColor: el('apGroundColor').value,
  groundColorDisabled: el('apGroundColor').disabled,
  floorPlanChecked: el('apFloorPlan').checked,
  contoursChecked: el('apContours').checked,
  xrayChecked: el('apXray').checked,
  opacitySlider: Number(el('apOpacity').value),
  opacityLabel: el('apOpacityVal').textContent,
  opacityRowOff: el('apOpacityRow').classList.contains('off'),
  opacityDisabled: el('apOpacity').disabled,
  opacityVisible: !!el('apOpacity').offsetParent,
  measurePanelOpen: el('measurePanel').classList.contains('on'),
  measureButtonOn: el('btnMeasure').classList.contains('on'),
});

// 游戏式测距：与工具条/面板走同一条生产路径（都落在 Model3D 上），再回写界面
viewer.measureState = () => model.measurementState();
viewer.setMeasure = (v) => { const r = model.setMeasurement(v); syncMeasurePanel(); return r; };
viewer.toggleMeasure = () => { const r = model.toggleMeasurement(); syncMeasurePanel(); return r; };
viewer.measureSurface = () => model.measureSurfacePoint();
viewer.measureCenter = () => model.measureObjectCenter();
viewer.measureCancel = () => model.cancelMeasurement();
viewer.measureDeleteLast = () => model.removeLastMeasurement();
viewer.measureUndo = () => model.undoLastMeasurement();
viewer.setContinuous = (v) => { const r = model.setMeasureContinuous(v); syncMeasurePanel(); return r; };
viewer.measureClear = () => { const r = model.clearMeasurements(); syncMeasurePanel(); return r; };
viewer.setMeasureComponents = (v) => {
  const r = model.setMeasureComponents(v); syncMeasurePanel(); return r;
};
viewer.measureClipboardText = () => model.measurementClipboardText();
viewer.copyMeasurements = () => copyMeasurements();
viewer.measureUi = () => ({
  panelOpen: measurePanelOpen,
  panelVisible: el('measurePanel').classList.contains('on'),
  buttonOn: el('btnMeasure').classList.contains('on'),
  xyzChecked: el('measureXyz').checked,
  xyzDisabled: el('measureXyz').disabled,
  copyDisabled: el('measureCopy').disabled,
  toast: el('toast').classList.contains('on') ? (el('toast').innerText || '') : null,
  reticleVisible: el('measureReticle').classList.contains('on'),
  // 字形是 SVG 几何（按 data-state 显示对应 <g>），这里回报它与界面语义一致的字形字符
  reticleGlyph: ({
    miss: MeasureGlyph.miss, surface: MeasureGlyph.surface,
    center: MeasureGlyph.center, recorded: MeasureGlyph.recorded,
  })[el('measureReticle').dataset.state] || null,
  reticleState: el('measureReticle').dataset.state || null,
  reticleShapeCenter: (() => {
    // 当前可见的那个 <g> 的几何中心 vs 准星盒中心：用来断言"准星与测量圈同心"
    const el = document.getElementById('measureReticle');
    const c = el.getBoundingClientRect();
    const svg = el.querySelector('svg').getBoundingClientRect();
    return { svgCenter: { x: +(svg.left + svg.width / 2).toFixed(2),
      y: +(svg.top + svg.height / 2).toFixed(2) },
    boxCenter: { x: +(c.left + c.width / 2).toFixed(2), y: +(c.top + c.height / 2).toFixed(2) } };
  })(),
  reticleCenter: (() => {
    const r = el('measureReticle').getBoundingClientRect();
    const c = el('center').getBoundingClientRect();
    return { x: +(r.left + r.width / 2 - c.left).toFixed(1),
             y: +(r.top + r.height / 2 - c.top).toFixed(1),
             cx: +(c.width / 2).toFixed(1), cy: +(c.height / 2).toFixed(1) };
  })(),
  items: el('measureList').querySelectorAll('.mitem').length,
  labels: el('measureLabels').querySelectorAll('.mlabel').length,
  labelTexts: [...el('measureLabels').querySelectorAll('.mlabel')].map((d) => d.textContent),
  componentLabels: el('measureLabels').querySelectorAll('.mlabel.comp').length,
  componentLabelTexts: [...el('measureLabels').querySelectorAll('.mlabel.comp')]
    .filter((d) => d.style.display !== 'none').map((d) => d.textContent),
  labelVisible: [...el('measureLabels').querySelectorAll('.mlabel')]
    .filter((d) => d.style.display !== 'none').length,
  axesText: el('measureAxes').textContent,
  clearDisabled: el('measureClear').disabled,
  listText: (el('measureList').innerText || '').slice(0, 600),
  nowText: (el('measureNow').innerText || '').slice(0, 400),
});
viewer.fit = (c) => model.fit(c);
viewer.enableBatchRendering = (options) => model.enableBatchRendering(options);
viewer.disableBatchRendering = () => model.disableBatchRendering();
viewer.batchRenderingState = () => model.batchRendering?.stats() || { enabled: false };
viewer.batchRenderingManifest = () => model.batchRendering?.manifest() || null;
viewer.openModel = async (pid, mid, vid) => { await am.openVersion(pid, mid, vid); return viewer.current; };
viewer.backToLauncher = () => backToLauncher();
viewer.launcherState = () => ({
  visible: el('launcher').classList.contains('on'),
  totals: am.data.totals || {},
  projects: (am.data.projects || []).map((p) => ({
    id: p.id, name: p.name,
    models: p.models.map((m) => ({
      id: m.id, name: m.name,
      versions: m.versions.map((v) => ({ id: v.id, name: v.name, status: v.status,
        rvmBytes: v.rvmBytes, glbBytes: v.glbBytes })),
    })),
  })),
  sel: { ...am.sel },
  treeRows: am.treeEl.querySelectorAll('.pm-row').length,
});
viewer.navState = () => model.navigationState();
viewer.setNavMode = (m) => { model.setNavigationMode(m); return model.navigationState(); };
viewer.toggleNavMode = () => { model.toggleNavigationMode(); return model.navigationState(); };
viewer.navSettings = () => model.navigationSettings.current;
viewer.setNavSettings = (v) => { const saved = model.navigationSettings.save(v); syncNavSettingsInputs(); return saved; };
viewer.resetNavSettings = () => { const saved = model.navigationSettings.reset(); syncNavSettingsInputs(); return saved; };
viewer.pointerLocked = () => document.pointerLockElement === model.canvas;
viewer.crosshairVisible = () => el('crosshair').classList.contains('on');
viewer.navPromptVisible = () => el('navPrompt').classList.contains('on');
viewer.navHintText = () => el('hint').textContent;
viewer.orbitEnabled = () => model.controls.enabled;
viewer.cameraPose = () => ({
  position: model.camera.position.toArray(),
  quaternion: model.camera.quaternion.toArray(),
  up: model.camera.up.toArray(),
  fov: model.camera.fov,
  target: model.controls.target.toArray(),
});
viewer.navCore = {
  CameraMath, CameraFrame, CrosshairVisibility, InputState, NavigationKey,
  NavigationDefaults, MouseSensitivityRadiansPerPixel, MaxPitchRadians, WORLD_UNITS_PER_METER,
  createDefaultSettings, validateOrDefault, NavigationSettingsStore, normalizeWheelEvent,
};
viewer.buttonState = () => ({
  hide: el('btnHide').disabled, isolate: el('btnIsolate').disabled,
  showAll: el('btnShowAll').disabled,
});
viewer.treeState = () => ({
  selectedId: tree?.selectedId ?? null,
  selectedIds: tree ? [...tree.selectedIds] : [],
  selectedCount: tree?.selectedIds.size ?? 0,
  selectedRowText: tree?.rows.get(tree.selectedId)?.textContent || null,
  rowsRendered: tree?.rows.size ?? 0,
  expanded: tree?.expanded.size ?? 0,
  firstRows: [...el('tree').querySelectorAll('.row')].slice(0, 6)
    .map((r) => r.textContent.trim()),
});
viewer.propState = () => ({
  info: el('propInfo').textContent,
  text: (el('props').innerText || '').slice(0, 1200),
});
viewer.panelState = () => ({
  leftVisible: !el('left').classList.contains('hidden'),
  rightVisible: !el('right').classList.contains('hidden'),
  treeBtnOn: el('btnToggleTree').classList.contains('on'),
  propsBtnOn: el('btnToggleProps').classList.contains('on'),
});
viewer.searchState = () => ({
  query: el('treeSearchInput').value,
  visible: !el('searchResults').classList.contains('hidden'),
  summary: el('searchResults').querySelector('.summary')?.textContent || null,
  hits: el('searchResults').querySelectorAll('.hit').length,
});
viewer.memory = () => (performance.memory ? {
  usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
  totalMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
  limitMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1),
  precise: !!performance.memory.usedJSHeapSize,
} : null);
/** three.js 资源计数：切换模型后这两个数应当回到加载后的水平，不应逐次增长 */
viewer.gpuInfo = () => ({
  geometries: model.renderer.info.memory.geometries,
  textures: model.renderer.info.memory.textures,
  programs: model.renderer.info.programs?.length ?? null,
  sceneChildren: model.scene.children.length,
  namedNodes: model.nodeByCanonical.size,
  meshRefs: model.meshByCanonical.size,
  hidden: model.hiddenCanonicals.size,
  selected: model.selected,
  outlineObjects: model.outline.selectedObjects.length,
  ready: model.ready,
});
viewer.projectCanonical = (canonical) => {
  const node = model.nodeByCanonical.get(canonical);
  if (!node) return null;
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) return null;
  const p = box.getCenter(new THREE.Vector3()).project(model.camera);
  const r = model.renderer.domElement.getBoundingClientRect();
  return {
    x: r.left + (p.x + 1) / 2 * r.width,
    y: r.top + (-p.y + 1) / 2 * r.height,
    ndc: [p.x, p.y, p.z],
  };
};
viewer.title = () => ({
  project: el('curProject').textContent, model: el('curModel').textContent,
  version: el('curVersion').textContent, tab: document.title,
});
