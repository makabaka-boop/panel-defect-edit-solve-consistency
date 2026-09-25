import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.jsx";

// 构造面积平铺整板的合法解：成品放满可放格，scrap 兜底剩余区域
function solutionFor(body, overrides = {}) {
  const bw = body.board_width;
  const bh = body.board_height;
  const pw = body.piece_width;
  const ph = body.piece_height;
  const pieces = [];
  let used = 0;
  for (let y = 0; y + ph <= bh; y += ph) {
    for (let x = 0; x + pw <= bw; x += pw) {
      const overDefect = (body.defects || []).some(
        ([dx, dy]) => dx >= x && dx < x + pw && dy >= y && dy < y + ph
      );
      if (overDefect) continue;
      pieces.push({ x, y, width: pw, height: ph, rotated: false });
      used += pw * ph;
    }
  }
  return {
    piece_count: pieces.length,
    cut_count: 0,
    pieces,
    scraps: used < bw * bh ? [{ x: 0, y: 0, width: bw, height: bh }] : [],
    cuts: [],
    tree: { x: 0, y: 0, width: bw, height: bh, kind: "leaf" },
    ...overrides,
  };
}

function deferredJson(body) {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve(value = solutionFor(body)) {
      resolve({ ok: true, status: 200, json: async () => value });
    },
    rejectNetwork(message = "网络中断") {
      reject(Object.assign(new Error(message), { name: "TypeError" }));
    },
    resolveStatus(status) {
      resolve({
        ok: false,
        status,
        json: async () => ({ detail: `请求失败 (${status})` }),
      });
    },
  };
}

function getBoard() {
  return screen.getByRole("img", { name: "板材编辑与排样结果" });
}

function fieldByLabel(text) {
  return screen.getByText(text).closest("label").querySelector("input");
}

function solveButton() {
  return screen.getByRole("button", { name: /求解/ });
}

function defectMarks() {
  return within(getBoard()).getAllByText("✕");
}

function pieceLabels() {
  return within(getBoard()).getAllByText(/^\d+×\d+$/);
}

// 统计区 <strong> 数值按标签定位
function statValue(label) {
  const span = screen.getByText(label);
  return span.parentElement.querySelector("strong").textContent;
}

describe("排料台验收", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  test("选中板宽全值重输：空串/0 中间态不删除最终板面内瑕疵，恢复后瑕疵与可切区域一致", async () => {
    const user = userEvent.setup();
    render(<App />);

    // 初始 5×2 板，默认瑕疵 (4,0)
    expect(defectMarks()).toHaveLength(1);

    // 全选板宽 -> 清空（编辑中间态）-> 重输 5
    const w = fieldByLabel("板宽 (2–10)");
    await user.tripleClick(w);
    await user.keyboard("{Backspace}");
    expect(w.value).toBe("");
    // 中间空串不得被当作宽度 0：瑕疵保留、板仍是 5 列
    expect(defectMarks()).toHaveLength(1);
    expect(getBoard().querySelectorAll("g.cell")).toHaveLength(10);

    await user.type(w, "5");
    expect(w.value).toBe("5");
    expect(defectMarks()).toHaveLength(1);

    // 提交：请求仍携带瑕疵 (4,0)
    let sentBody;
    fetch.mockImplementationOnce((url, init) => {
      sentBody = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => solutionFor(sentBody),
      });
    });
    await user.click(solveButton());

    expect(sentBody.board_width).toBe(5);
    expect(sentBody.defects).toEqual([[4, 0]]);

    await waitFor(() =>
      expect(screen.getByText("成品件数")).toBeInTheDocument()
    );
    // 2×2 件在 5×2 上可放 x=0、x=2 两块；x=3 块含瑕疵 (4,0) 必须作废料
    expect(statValue("成品件数")).toBe("2");
    const labels = pieceLabels();
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.textContent)).toEqual(["2×2", "2×2"]);
    // 瑕疵依旧叠画
    expect(defectMarks()).toHaveLength(1);
  });

  test("请求先后交错：旧请求成功结果不覆盖新输入，图形/统计/切割清单对应最新版", async () => {
    const user = userEvent.setup();
    render(<App />);

    // 第一次请求（5×2 无锯缝）挂起
    const first = deferredJson({
      board_width: 5,
      board_height: 2,
      piece_width: 2,
      piece_height: 2,
      allow_rotation: false,
      kerf_cells: 0,
      defects: [[4, 0]],
    });
    fetch.mockImplementationOnce(() => first.promise);
    await user.click(solveButton());
    expect(solveButton()).toBeDisabled();
    const firstSignal = fetch.mock.calls[0][1].signal;

    // 未返回时勾选锯缝并新增瑕疵 (0,0)
    await user.click(screen.getByText("锯缝 1 格"));
    expect(firstSignal.aborted).toBe(true);
    fireEvent.click(getBoard().querySelectorAll("g.cell")[0]);
    expect(defectMarks()).toHaveLength(2);

    // 旧请求此刻“成功”：结果必须丢弃（无锯缝、7 刀的过期方案不得出现）
    first.resolve(
      solutionFor({
        board_width: 5,
        board_height: 2,
        piece_width: 2,
        piece_height: 2,
        defects: [[4, 0]],
      }, { cut_count: 7 })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText("成品件数")).not.toBeInTheDocument();
    expect(screen.queryByText("锯缝格数")).not.toBeInTheDocument();

    // 提交第二版请求（锯缝 1 + 两个瑕疵）
    const second = deferredJson({
      board_width: 5,
      board_height: 2,
      piece_width: 2,
      piece_height: 2,
      allow_rotation: false,
      kerf_cells: 1,
      defects: [
        [4, 0],
        [0, 0],
      ],
    });
    fetch.mockImplementationOnce(() => second.promise);
    await user.click(solveButton());

    const sentBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(sentBody.kerf_cells).toBe(1);
    expect(sentBody.defects).toEqual(
      expect.arrayContaining([[4, 0], [0, 0]])
    );

    // 第二版返回：1 刀 V 切，锯缝吃掉 x=2 一列（1×2）
    second.resolve(
      solutionFor(
        {
          board_width: 5,
          board_height: 2,
          piece_width: 2,
          piece_height: 2,
          defects: [
            [4, 0],
            [0, 0],
          ],
        },
        {
          cut_count: 1,
          cuts: [
            {
              order: 1,
              orientation: "V",
              coord: 2,
              rect: { x: 0, y: 0, width: 5, height: 2 },
              kerf: { x: 2, y: 0, width: 1, height: 2 },
            },
          ],
          scraps: [
            { x: 0, y: 0, width: 5, height: 2 },
            { x: 2, y: 0, width: 1, height: 2, kerf: true },
          ],
        }
      )
    );

    await waitFor(() =>
      expect(screen.getByText("成品件数")).toBeInTheDocument()
    );

    // 统计/清单/图形必须全部是第二版（1 刀、锯缝 2 格），旧方案 7 刀不得出现
    expect(statValue("切割次数")).toBe("1");
    expect(statValue("锯缝格数")).toBe("2");
    expect(screen.getByText(/第 1 刀/)).toBeInTheDocument();
    expect(screen.queryByText("7")).not.toBeInTheDocument();
    expect(getBoard().querySelectorAll("rect.kerf")).toHaveLength(1);
    expect(getBoard().querySelectorAll(".cut-num")).toHaveLength(1);
    // 瑕疵标记与新输入一致
    expect(defectMarks()).toHaveLength(2);
  });

  test("旧请求失败：新输入有效后错误提示不出现，新方案正常呈现", async () => {
    const user = userEvent.setup();
    render(<App />);

    const first = deferredJson({
      board_width: 5,
      board_height: 2,
      piece_width: 2,
      piece_height: 2,
      allow_rotation: false,
      kerf_cells: 0,
      defects: [[4, 0]],
    });
    fetch.mockImplementationOnce(() => first.promise);
    await user.click(solveButton());
    const firstSignal = fetch.mock.calls[0][1].signal;

    // 未返回时切换锯缝（新的有效输入），旧请求作废
    await user.click(screen.getByText("锯缝 1 格"));
    expect(firstSignal.aborted).toBe(true);

    // 旧请求以网络失败告终：错误提示不得出现
    first.rejectNetwork("boom");
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/boom|请求失败/)).not.toBeInTheDocument();
    expect(solveButton()).not.toBeDisabled();

    // 重新提交，新请求成功
    let sentBody;
    fetch.mockImplementation((url, init) => {
      sentBody = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => solutionFor(sentBody),
      });
    });
    await user.click(solveButton());
    expect(sentBody.kerf_cells).toBe(1);

    await waitFor(() =>
      expect(screen.getByText("成品件数")).toBeInTheDocument()
    );
    expect(screen.queryByText(/boom|请求失败/)).not.toBeInTheDocument();
    expect(statValue("成品件数")).toBe("2");
  });

  test("旧请求 500：新输入有效后不显示旧 500 错误，可再次正常求解", async () => {
    const user = userEvent.setup();
    render(<App />);

    const first = deferredJson({
      board_width: 5,
      board_height: 2,
      piece_width: 2,
      piece_height: 2,
      allow_rotation: false,
      kerf_cells: 0,
      defects: [[4, 0]],
    });
    fetch.mockImplementationOnce(() => first.promise);
    await user.click(solveButton());

    await user.click(screen.getByText("锯缝 1 格"));
    first.resolveStatus(500);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/请求失败/)).not.toBeInTheDocument();
    expect(solveButton()).not.toBeDisabled();

    fetch.mockImplementation((url, init) => {
      const body = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => solutionFor(body),
      });
    });
    await user.click(solveButton());
    await waitFor(() =>
      expect(screen.getByText("成品件数")).toBeInTheDocument()
    );
    expect(statValue("成品件数")).toBe("2");
  });
});
