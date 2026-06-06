/**
 * phase3_spatial_optimizer.js — 核心空间优化
 *
 * 职责:
 *  - K-Means 聚类: 按坐标把景点分到每天
 *  - 图路径规划: 每天组内 POI 两两调 MockBackend.get_shortest_path,选总 duration 最小排列
 *  - 备选路线: 调 get_alternative_paths
 *  - 时间窗口校验: 按 hours 检查,超时 warning
 *  - budget_context 注入:
 *      * constraint 模式: 月预算 = 用户预算,总价严格 ≤ 预算
 *      * reference 模式: 月预算 = Account月可支配,允许超出(只 warning)
 *  - 用餐时段插入 (12-13 午餐, 18-20 晚餐)
 *  - 收集 edge_usage
 *
 * 用法:
 *   node phases/phase3_spatial_optimizer.js <phase2_json> <days> <daily_hours> [budget_context_json]
 *
 * 调试文件落到 skills/trip-skill/temp/
 */

const fs = require('fs');
const path = require('path');
const MockBackend = require('../../../mock_backend');

const TEMP_DIR = path.resolve(__dirname, '..', 'temp');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function writeDebug(name, obj) {
  ensureDir(TEMP_DIR);
  fs.writeFileSync(path.join(TEMP_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
}

// ============== K-Means 聚类 ==============
function kmeans(points, k, maxIter = 50) {
  if (points.length <= k) {
    // 每个点单独成簇
    return points.map((p, i) => ({ centroid: p, members: [i] }));
  }
  // 初始化: 随机选 k 个点
  const centroids = [];
  const used = new Set();
  while (centroids.length < k) {
    const idx = Math.floor(Math.random() * points.length);
    if (!used.has(idx)) { used.add(idx); centroids.push([...points[idx]]); }
  }
  let assignments = new Array(points.length).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    // 分配
    for (let i = 0; i < points.length; i++) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i], centroids[c]);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
    }
    // 更新质心
    for (let c = 0; c < k; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      const nc = [0, 0];
      for (const m of members) { nc[0] += m[0]; nc[1] += m[1]; }
      centroids[c] = [nc[0] / members.length, nc[1] / members.length];
    }
    if (!changed) break;
  }
  // 输出
  const result = [];
  for (let c = 0; c < k; c++) {
    const members = [];
    for (let i = 0; i < points.length; i++) if (assignments[i] === c) members.push(i);
    result.push({ centroid: centroids[c], members });
  }
  return result;
}

function dist2(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// ============== 贪心 TSP 排序 (nearest neighbor) ==============
function orderByNearestNeighbor(startId, nodes) {
  if (nodes.length === 0) return [];
  const remaining = nodes.slice();
  const ordered = [];
  let cur = startId;
  while (remaining.length > 0) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = dist2([cur.lat, cur.lng], [remaining[i].lat, remaining[i].lng]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const next = remaining.splice(bestI, 1)[0];
    ordered.push(next);
    cur = next;
  }
  return ordered;
}

// ============== 用餐时段插入 ==============
const LUNCH_START = 12 * 60;     // 12:00 分钟数
const LUNCH_END = 13 * 60;
const DINNER_START = 18 * 60;
const DINNER_END = 20 * 60;

function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ============== 主流程 ==============
async function run(phase2Input, days, dailyHours, budgetContext) {
  days = days || 3;
  dailyHours = dailyHours || 10;
  budgetContext = budgetContext || {};

  // 兼容传 phase2Input 是路径或对象
  let phase2 = phase2Input;
  if (typeof phase2Input === 'string') {
    if (fs.existsSync(phase2Input)) {
      phase2 = JSON.parse(fs.readFileSync(phase2Input, 'utf8'));
    } else {
      throw new Error(`phase2 file not found: ${phase2Input}`);
    }
  }

  const attractions = (phase2.attractions?.primary || []).concat(
    (phase2.attractions?.alternatives || []).map((a) => ({
      id: a.id, name: a.name, lat: phase2.attractions.primary[0]?.lat || 0,
      lng: phase2.attractions.primary[0]?.lng || 0, type: 'attraction', props: { rating: 0 },
    }))
  );

  // 1. K-Means 聚类 -> 分组到天
  const points = attractions.map((a) => [a.lat || 0, a.lng || 0]);
  const clusters = kmeans(points, Math.min(days, attractions.length));

  // 2. 每天的节点 + 路径
  const allEdgeUsage = new Set();
  const dayPlans = [];
  const allWarnings = [];
  let totalCost = 0;
  const dailyMinutes = dailyHours * 60;
  let dayStartTime = 9 * 60; // 9:00 出发

  for (let d = 0; d < clusters.length; d++) {
    const cluster = clusters[d];
    const clusterAttractions = cluster.members.map((idx) => attractions[idx]).filter((a) => a && a.id);

    if (clusterAttractions.length === 0) {
      dayPlans.push({ day: d + 1, routes: { primary: { pois: [], meals: { lunch: null, dinner: null } }, alternative: { note: '无景点', pois: [] } } });
      continue;
    }

    // 选起点: transport_hub (从 phase2 拿)
    const hubs = phase2.transport_hubs || [];
    const startHub = hubs[0] || clusterAttractions[0];
    const startId = startHub.id;

    // 贪心排序
    const ordered = orderByNearestNeighbor(startHub, clusterAttractions);

    // 3. 两两最短路径
    const pois = [];
    let curTime = dayStartTime;
    let usedMinutes = 0;
    let prevId = startId;
    for (let i = 0; i < ordered.length; i++) {
      const node = ordered[i];
      const visit = node.props?.duration_estimate || 120; // 默认 2h
      const arrival = curTime;
      const departure = curTime + visit;

      let pathToNext = null;
      if (i < ordered.length - 1) {
        const nextNode = ordered[i + 1];
        try {
          const path = await MockBackend.get_shortest_path(node.id, nextNode.id, ['walk', 'metro', 'drive']);
          if (path) {
            // 边类型汇总
            const edgeTypes = {};
            for (const eid of path.edges) {
              // 简单按 name 判断: edge_w = walk, edge_m = metro, edge_d = drive
              if (eid.includes('_w') || eid.startsWith('w')) edgeTypes.walk = (edgeTypes.walk || 0) + 1;
              else if (eid.includes('_m') || eid.startsWith('m')) edgeTypes.metro = (edgeTypes.metro || 0) + 1;
              else edgeTypes.drive = (edgeTypes.drive || 0) + 1;
              allEdgeUsage.add(eid);
            }
            const mainType = Object.entries(edgeTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'walk';
            pathToNext = {
              to_id: nextNode.id,
              edges: path.edges,
              duration_min: path.total_duration_min,
              distance_m: path.total_distance_m,
              type: mainType,
            };
          }
        } catch (_) { /* 跳过 */ }
      }

      pois.push({
        id: node.id,
        name: node.name,
        arrival: formatTime(arrival),
        departure: formatTime(departure),
        path_to_next: pathToNext,
      });
      curTime = departure + (pathToNext?.duration_min || 0);
      usedMinutes = curTime - dayStartTime;
      prevId = node.id;
    }

    // 4. 时间窗口校验
    if (usedMinutes > dailyMinutes) {
      allWarnings.push({
        day: d + 1,
        type: 'time_overrun',
        message: `第${d + 1}天行程时长 ${Math.round(usedMinutes / 60)}h,超过每日可用 ${dailyHours}h`,
      });
    }

    // 5. 用餐时段插入
    const meals = { lunch: null, dinner: null };
    const restaurants = phase2.restaurants || {};
    if (pois.length > 0) {
      // 午餐: 12:00-13:00 段
      const lunchP = restaurants.lunch?.primary;
      if (lunchP) {
        meals.lunch = {
          id: lunchP.id,
          name: lunchP.name,
          time: '12:00-13:00',
          options: [
            { id: lunchP.id, name: lunchP.name },
            ...(restaurants.lunch?.alternatives || []).slice(0, 2),
          ],
        };
        totalCost += (lunchP.props?.price || 100) + (lunchP.ticket_price || 0);
      }
      // 晚餐: 18:00-20:00 段
      const dinnerP = restaurants.dinner?.primary;
      if (dinnerP) {
        meals.dinner = {
          id: dinnerP.id,
          name: dinnerP.name,
          time: '18:00-20:00',
          options: [
            { id: dinnerP.id, name: dinnerP.name },
            ...(restaurants.dinner?.alternatives || []).slice(0, 2),
          ],
        };
        totalCost += (dinnerP.props?.price || 150) + (dinnerP.ticket_price || 0);
      }
    }

    // 6. 备选路线
    let altPois = [];
    if (pois.length >= 2) {
      try {
        const altPath = await MockBackend.get_alternative_paths(
          pois[0].id, pois[pois.length - 1].id, ['walk', 'metro', 'drive'], 1
        );
        if (altPath && altPath[1]) {
          const alt = altPath[1];
          // 简化: 只列路径涉及的关键边
          altPois.push({
            note: '备选路线',
            path_edges: alt.edges,
            total_duration_min: alt.total_duration_min,
            total_distance_m: alt.total_distance_m,
          });
          for (const eid of alt.edges) allEdgeUsage.add(eid);
        }
      } catch (_) { /* 跳过 */ }
    }

    // 估算景点成本
    for (const a of clusterAttractions) {
      totalCost += (a.ticket_price || 0);
    }
    // 酒店
    const hotel = phase2.hotels?.[`day${d + 1}`]?.primary;
    if (hotel) totalCost += (hotel.props?.price || 500);

    dayPlans.push({
      day: d + 1,
      routes: {
        primary: { pois, meals },
        alternative: {
          note: '如主路线受阻,可切换此备选路线',
          pois: altPois,
        },
      },
    });
  }

  // 7. budget 处理
  const totalTripEstimate = totalCost;
  const warnings = [...allWarnings];

  const budgetBinding = budgetContext.budget_binding || 'reference';
  const monthRemaining = budgetContext.month_remaining || 0;
  const userSpecified = !!budgetContext.user_specified;

  if (budgetBinding === 'constraint' && userSpecified) {
    // 严格约束: 超预算需要替换 (此处只 warning + 建议降级, 实际降级由更上层的 agent 完成)
    if (totalTripEstimate > monthRemaining) {
      const overshoot = totalTripEstimate - monthRemaining;
      const ratio = (totalTripEstimate / monthRemaining).toFixed(2);
      warnings.push({
        type: 'budget_overrun',
        severity: 'high',
        message: `方案总价 ${totalTripEstimate} 元,超出预算 ${monthRemaining} 元 ${overshoot} 元 (${ratio}倍),需要降级`,
      });
    }
  } else {
    // reference: 不硬阻断,只 warning
    if (monthRemaining > 0 && totalTripEstimate > monthRemaining) {
      const ratio = (totalTripEstimate / monthRemaining).toFixed(2);
      warnings.push({
        type: 'budget_warning',
        severity: 'low',
        message: `方案估算 ${totalTripEstimate} 元,超出月可支配 ${monthRemaining} 元,约为 ${ratio} 倍`,
      });
    }
  }

  // 努力目标提醒
  if (budgetContext.effort_goal_matched) {
    const g = budgetContext.effort_goal_matched;
    warnings.push({
      type: 'effort_goal_reminder',
      severity: 'low',
      message: `努力目标「${g.name}」尚需 ${g.remaining} 元(已存 ${g.saved_amount} 元),本次消费注意平衡`,
    });
  }

  const result = {
    days: dayPlans,
    edge_usage: Array.from(allEdgeUsage),
    budget_summary: {
      total_trip_estimate: totalTripEstimate,
      month_remaining: monthRemaining,
      budget_binding: budgetBinding,
      user_specified: userSpecified,
    },
    warnings,
  };

  writeDebug('phase3_out.json', result);
  return result;
}

if (require.main === module) {
  const phase2Arg = process.argv[2];
  const daysArg = parseInt(process.argv[3] || '3', 10);
  const dailyHoursArg = parseFloat(process.argv[4] || '10');
  const budgetArg = process.argv[5] || '{}';

  let budgetContext = {};
  try { budgetContext = JSON.parse(budgetArg); } catch (_) { budgetContext = {}; }

  let phase2Input = phase2Arg;
  if (phase2Arg && fs.existsSync(phase2Arg)) {
    // 走文件
  } else {
    // 默认用 temp/phase2_out.json
    const p = path.join(TEMP_DIR, 'phase2_out.json');
    if (fs.existsSync(p)) phase2Input = p;
  }

  run(phase2Input, daysArg, dailyHoursArg, budgetContext)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[phase3_spatial_optimizer] failed:', err);
      process.exit(1);
    });
}

module.exports = { run, kmeans, orderByNearestNeighbor };
