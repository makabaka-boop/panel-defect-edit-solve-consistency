import { useEffect, useRef, useState } from "react";

// SVG 每格像素
const CELL = 56;

// 数字输入框：用本地文本缓冲承接编辑中间态（含“选中全值后清空再重输”的短暂空串），
// 仅当内容能解析为有限数字时才向上提交；失焦时丢弃未提交的非法内容、回到已确认值。
function NumberField({ label, value, min, max, onChange }) {
  const [text, setText] = useState(String(value));

  // 外部已确认值变化（如失焦回弹）时同步显示
  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commit(raw) {
    setText(raw);
    if (raw.trim() === "") return; // 清空重输的中间态，不提交
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(n);
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setText(String(value))}
      />
    </label>
  );
}

export default function App() {
  const [boardW, setBoardW] = useState(5);
  const [boardH, setBoardH] = useState(2);
  const [pieceW, setPieceW] = useState(2);
  const [pieceH, setPieceH] = useState(2);
  const [allowRotation, setAllowRotation] = useState(false);
  const [kerfCells, setKerfCells] = useState(0);
  const [defects, setDefects] = useState([{ x: 4, y: 0 }]);
  const [solution, setSolution] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // 在途试算请求的身份：序号递增 + AbortController。
  // 只有“仍是最新一版输入”的请求允许写回方案/错误，旧请求一律丢弃。
  const reqSeq = useRef(0);
  const abortRef = useRef(null);

  // 输入已变更：废弃在途请求并清空其可能写回的过期结果。
  // 保证图形、统计、下刀清单始终对应最后确认的一版输入。
  function invalidatePending() {
    reqSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setSolution(null);
    setError(null);
  }

  // 板尺寸变化后，清掉越界瑕疵与旧方案。
  // 仅接受已确认的合法尺寸（2–10 整数）：输入中间态（空串/0/越界）不得触发，
  // 否则“选中板宽重输”时短暂的 0 宽会把仍在最终板面内的瑕疵永久删掉。
  function resizeBoard(nw, nh) {
    if (!Number.isInteger(nw) || !Number.isInteger(nh)) return;
    if (nw < 2 || nw > 10 || nh < 2 || nh > 10) return;
    setBoardW(nw);
    setBoardH(nh);
    setDefects((ds) => ds.filter((d) => d.x < nw && d.y < nh));
    invalidatePending();
  }

  function toggleCell(x, y) {
    setDefects((ds) => {
      const exists = ds.some((d) => d.x === x && d.y === y);
      return exists
        ? ds.filter((d) => !(d.x === x && d.y === y))
        : [...ds, { x, y }];
    });
    invalidatePending();
  }

  async function solve() {
    // 先废弃上一版输入的在途请求，再按当前确认值拍快照
    reqSeq.current += 1;
    const seq = reqSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const payload = {
      board_width: boardW,
      board_height: boardH,
      piece_width: pieceW,
      piece_height: pieceH,
      allow_rotation: allowRotation,
      kerf_cells: kerfCells,
      defects: defects.map((d) => [d.x, d.y]),
    };

    setLoading(true);
    setError(null);
    setSolution(null);
    try {
      const resp = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const msg =
          data?.detail?.map?.((d) => `${d.loc.slice(1).join(".")}: ${d.msg}`) ||
          data?.detail ||
          `请求失败 (${resp.status})`;
        throw new Error(Array.isArray(msg) ? msg.join("\n") : String(msg));
      }
      const data = await resp.json();
      // 旧请求的成功结果不得覆盖更新版本输入
      if (seq !== reqSeq.current) return;
      setSolution(data);
    } catch (e) {
      // 被新输入主动取消、或已不是最新请求时：静默丢弃
      if (e.name === "AbortError" || seq !== reqSeq.current) return;
      setError(e.message);
    } finally {
      if (seq === reqSeq.current) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }

  const svgW = boardW * CELL;
  const svgH = boardH * CELL;
  const cuts = solution?.cuts ?? [];
  const kerfArea =
    solution?.scraps
      .filter((s) => s.kerf)
      .reduce((acc, s) => acc + s.width * s.height, 0) ?? 0;

  return (
    <div className="app">
      <header>
        <h1>板材直切排样台</h1>
        <p>
          点击格子标记/取消瑕疵，求解后在全部直切树中取成品最多、刀数最少的方案，
          红线按编号顺序即可逐刀下切。
        </p>
      </header>

      <main>
        <section className="panel">
          <div className="form">
            <NumberField label="板宽 (2–10)" value={boardW} min={2} max={10}
              onChange={(v) => resizeBoard(v, boardH)} />
            <NumberField label="板高 (2–10)" value={boardH} min={2} max={10}
              onChange={(v) => resizeBoard(boardW, v)} />
            <NumberField label="件宽 (1–5)" value={pieceW} min={1} max={5}
              onChange={(v) => { setPieceW(v); invalidatePending(); }} />
            <NumberField label="件高 (1–5)" value={pieceH} min={1} max={5}
              onChange={(v) => { setPieceH(v); invalidatePending(); }} />
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={allowRotation}
                onChange={(e) => { setAllowRotation(e.target.checked); invalidatePending(); }}
              />
              <span>允许旋转 90°</span>
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={kerfCells === 1}
                onChange={(e) => { setKerfCells(e.target.checked ? 1 : 0); invalidatePending(); }}
              />
              <span>锯缝 1 格</span>
            </label>
            <button onClick={solve} disabled={loading}>
              {loading ? "求解中…" : "求解"}
            </button>
          </div>

          <div className="board-scroll">
            <svg
              width={svgW}
              height={svgH}
              viewBox={`0 0 ${svgW} ${svgH}`}
              className="board"
              role="img"
              aria-label="板材编辑与排样结果"
            >
              {/* 板材底 */}
              <rect x={0} y={0} width={svgW} height={svgH} className="board-bg" />

              {/* 锯缝格带的斜纹图案 */}
              <defs>
                <pattern
                  id="kerf-hatch"
                  width="7"
                  height="7"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="7" height="7" className="kerf-bg" />
                  <line x1={0} y1={0} x2={0} y2={7} className="kerf-stripe" />
                </pattern>
              </defs>

              {/* 废料块（叠画层 1，不含锯缝格带） */}
              {solution?.scraps.filter((r) => !r.kerf).map((r, i) => (
                <rect
                  key={`scrap-${i}`}
                  x={r.x * CELL}
                  y={r.y * CELL}
                  width={r.width * CELL}
                  height={r.height * CELL}
                  className="scrap"
                />
              ))}

              {/* 锯缝格带（叠画层 1.5：每刀吃掉的整行/列，显式标出） */}
              {solution?.scraps.filter((r) => r.kerf).map((r, i) => (
                <rect
                  key={`kerf-${i}`}
                  x={r.x * CELL}
                  y={r.y * CELL}
                  width={r.width * CELL}
                  height={r.height * CELL}
                  className="kerf"
                />
              ))}

              {/* 成品块（叠画层 2） */}
              {solution?.pieces.map((r, i) => (
                <g key={`piece-${i}`}>
                  <rect
                    x={r.x * CELL}
                    y={r.y * CELL}
                    width={r.width * CELL}
                    height={r.height * CELL}
                    className="piece"
                  />
                  <text
                    x={(r.x + r.width / 2) * CELL}
                    y={(r.y + r.height / 2) * CELL}
                    className="piece-label"
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {r.width}×{r.height}
                    {r.rotated ? " ↻" : ""}
                  </text>
                </g>
              ))}

              {/* 网格线（叠画层 3） */}
              {Array.from({ length: boardW + 1 }, (_, i) => (
                <line key={`gv-${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={svgH}
                  className="grid" />
              ))}
              {Array.from({ length: boardH + 1 }, (_, i) => (
                <line key={`gh-${i}`} x1={0} y1={i * CELL} x2={svgW} y2={i * CELL}
                  className="grid" />
              ))}

              {/* 瑕疵格（叠画层 4，编辑层，可点） */}
              {Array.from({ length: boardH }, (_, y) =>
                Array.from({ length: boardW }, (_, x) => {
                  const defected = defects.some((d) => d.x === x && d.y === y);
                  return (
                    <g
                      key={`cell-${x}-${y}`}
                      className="cell"
                      onClick={() => toggleCell(x, y)}
                    >
                      <rect
                        x={x * CELL}
                        y={y * CELL}
                        width={CELL}
                        height={CELL}
                        className={defected ? "defect" : "cell-hit"}
                      />
                      {defected && (
                        <text
                          x={(x + 0.5) * CELL}
                          y={(y + 0.5) * CELL}
                          className="defect-x"
                          textAnchor="middle"
                          dominantBaseline="central"
                        >
                          ✕
                        </text>
                      )}
                    </g>
                  );
                })
              )}

              {/* 切线（叠画层 5，贯穿当前矩形，带顺序号；
                  kerf=1 时画在被吃掉的锯缝格带中央） */}
              {cuts.map((c) => {
                const r = c.rect;
                const off = c.kerf ? 0.5 : 0;
                const x1 = c.orientation === "H" ? r.x * CELL : (c.coord + off) * CELL;
                const y1 = c.orientation === "H" ? (c.coord + off) * CELL : r.y * CELL;
                const x2 =
                  c.orientation === "H"
                    ? (r.x + r.width) * CELL
                    : (c.coord + off) * CELL;
                const y2 =
                  c.orientation === "H"
                    ? (c.coord + off) * CELL
                    : (r.y + r.height) * CELL;
                const badgeX =
                  c.orientation === "H" ? r.x * CELL + 14 : (c.coord + off) * CELL;
                const badgeY =
                  c.orientation === "H" ? (c.coord + off) * CELL : r.y * CELL + 14;
                return (
                  <g key={`cut-${c.order}`}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} className="cut-line" />
                    <circle cx={badgeX} cy={badgeY} r={11} className="cut-badge" />
                    <text
                      x={badgeX}
                      y={badgeY}
                      className="cut-num"
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {c.order}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="legend">
            <span><i className="sw piece" />成品</span>
            <span><i className="sw scrap" />废料</span>
            <span><i className="sw kerf" />锯缝（被吃掉）</span>
            <span><i className="sw defect" />瑕疵格（点击切换）</span>
            <span><i className="sw cut" />切割线（编号即下刀顺序）</span>
          </div>
        </section>

        <aside className="panel side">
          {error && <pre className="error">{error}</pre>}

          {solution && (
            <>
              <div className="stats">
                <div><strong>{solution.piece_count}</strong><span>成品件数</span></div>
                <div><strong>{solution.cut_count}</strong><span>切割次数</span></div>
                {kerfArea > 0 && (
                  <div><strong>{kerfArea}</strong><span>锯缝格数</span></div>
                )}
              </div>

              <h2>下刀顺序</h2>
              {solution.cuts.length === 0 && (
                <p className="muted">无需切割：整板直接作为{solution.piece_count ? "成品" : "废料"}。</p>
              )}
              <ol className="cuts">
                {solution.cuts.map((c) => (
                  <li key={c.order}>
                    第 {c.order} 刀：
                    {c.orientation === "H" ? "水平切" : "竖直切"}，
                    全局坐标 {c.orientation === "H" ? "y" : "x"} = {c.coord}
                    <span className="muted">
                      {" "}（切 {c.rect.width}×{c.rect.height} 块于 (
                      {c.rect.x}, {c.rect.y})）
                    </span>
                    {c.kerf && (
                      <span className="muted">
                        {" "}，锯缝吃掉{c.kerf.width}×{c.kerf.height} 于 (
                        {c.kerf.x}, {c.kerf.y})
                      </span>
                    )}
                  </li>
                ))}
              </ol>

              <h2>成品坐标</h2>
              <ul className="coords">
                {solution.pieces.map((p, i) => (
                  <li key={i}>
                    ({p.x}, {p.y}) {p.width}×{p.height}
                    {p.rotated ? "（旋转）" : ""}
                  </li>
                ))}
                {solution.pieces.length === 0 && <li className="muted">无成品</li>}
              </ul>
            </>
          )}

          {!solution && !error && (
            <p className="muted hint">
              编辑板材参数与瑕疵格后点击「求解」。目标件含瑕疵格的叶块只能作废料，
              普通面积除法会高估件数。勾选「锯缝 1 格」后，每刀会从当前矩形吃掉
              坐标处的一整行/列（可含瑕疵，但永远是被消耗的材料），
              成品、废料与锯缝的面积之和恰好等于板面积。
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}
