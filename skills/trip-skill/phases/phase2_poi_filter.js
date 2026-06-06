/**
 * phase2_poi_filter.js — POI 筛选
 *
 * 调 MockBackend.query_nodes 按 (type, city, tags) 查景点/餐厅/酒店
 * 按 rating 降序,每个类别输出 primary + alternatives
 * JOIN node_status 取实时状态
 *
 * 用法:
 *   node phases/phase2_poi_filter.js <城市> <偏好JSON>
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

/**
 * 主项构造 (从 DB row 抽取字段,做 props 兼容)
 */
function shapePrimary(node, type) {
  const props = node.props || {};
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    category: props.category || (type === 'attraction' ? '景点' : type === 'restaurant' ? '餐厅' : '酒店'),
    lat: node.lat,
    lng: node.lng,
    hours: props.hours || null,
    duration_estimate: props.duration_estimate || props.avg_visit_min || 120,
    rating: props.rating || 0,
    tags: props.tags || [],
    ticket_price: props.ticket_price || props.price || 0,
    price: props.price || null,
    status: node.status || 'open',
    status_reason: node.status_reason || null,
  };
}

/**
 * 备选项构造 (轻量)
 */
function shapeAlternative(node, reason) {
  return {
    id: node.id,
    name: node.name,
    reason,
    status: node.status || 'open',
  };
}

async function run(city, preference) {
  preference = preference || {};
  const poiTypes = Array.isArray(preference.poi_types) ? preference.poi_types : [];
  const foodCuisine = preference.food_cuisine || '';
  const shopping = !!preference.shopping;
  const altCount = preference.alternatives_count || 3;

  // 1. 读 phase1_out.json (如果有的话,作为偏好补充)
  let phase1 = {};
  const phase1Path = path.join(TEMP_DIR, 'phase1_out.json');
  if (fs.existsSync(phase1Path)) {
    try {
      phase1 = JSON.parse(fs.readFileSync(phase1Path, 'utf8'));
    } catch (_) { /* ignore */ }
  }

  // 合并偏好: 传入 > phase1
  const mergedTypes = poiTypes.length ? poiTypes : (phase1.poi_types || []);
  const mergedCuisine = foodCuisine || phase1.food_cuisine || '';

  // 2. 查景点
  const attractions = await MockBackend.query_nodes({
    type: 'attraction',
    city,
    tags: mergedTypes,
  });

  // 3. 查餐厅 (按 cuisine/category)
  const restaurants = await MockBackend.query_nodes({
    type: 'restaurant',
    city,
    category: mergedCuisine || undefined,
  });

  // 4. 查酒店
  const hotels = await MockBackend.query_nodes({
    type: 'hotel',
    city,
  });

  // 5. 查 transport_hub (供 phase3 起点用)
  const transportHubs = await MockBackend.query_nodes({
    type: 'transport_hub',
    city,
  });

  // 6. 输出: primary + alternatives (按 rating 降序)
  const topN = 1; // primary 选 1 个
  const openAttractions = attractions.filter((a) => a.status !== 'closed');
  const sortedAttr = openAttractions.slice().sort((a, b) => (b.props?.rating || 0) - (a.props?.rating || 0));
  const primaryAttr = sortedAttr.slice(0, topN).map((n) => shapePrimary(n, 'attraction'));
  const altAttr = sortedAttr.slice(topN, topN + altCount).map((n) => {
    const props = n.props || {};
    const why = [];
    if (props.rating >= 4.5) why.push(`评分${props.rating}`);
    if (n.status === 'limited') why.push(`当前限流(${n.status_reason || ''})`);
    if (props.tags && props.tags.length) why.push(props.tags.slice(0, 2).join('/'));
    return shapeAlternative(n, why.join('，') || '同类型备选');
  });

  // 餐厅按类型分: lunch(11-14), dinner(17-21)
  // 简化处理: 取 rating 高的做 lunch primary, 略低的做 dinner primary, 但实际上同图里可能没时段时间
  // 折中: 用 rating 排序,前后各分一组
  const openRestaurants = restaurants.filter((r) => r.status !== 'closed');
  const sortedRest = openRestaurants.slice().sort((a, b) => (b.props?.rating || 0) - (a.props?.rating || 0));
  const lunchPrimary = sortedRest.slice(0, 1).map((n) => shapePrimary(n, 'restaurant'));
  const lunchAlt = sortedRest.slice(1, 1 + altCount).map((n) =>
    shapeAlternative(n, `评分${n.props?.rating || 0}`)
  );
  // dinner 用不同子集: 中段开始
  const dinnerStart = Math.min(2, sortedRest.length);
  const dinnerPrimary = sortedRest.slice(dinnerStart, dinnerStart + 1).map((n) => shapePrimary(n, 'restaurant'));
  const dinnerAlt = sortedRest.slice(dinnerStart + 1, dinnerStart + 1 + altCount).map((n) =>
    shapeAlternative(n, `评分${n.props?.rating || 0}`)
  );

  // 酒店按 day 划分
  const openHotels = hotels.filter((h) => h.status !== 'closed');
  const sortedHotels = openHotels.slice().sort((a, b) => (b.props?.rating || 0) - (a.props?.rating || 0));
  const hotelsByDay = {};
  // days 从 phase1 拿,没有就 3 天
  const days = phase1.days || 3;
  for (let d = 1; d <= days; d++) {
    const i = (d - 1) % Math.max(1, sortedHotels.length);
    const primary = sortedHotels[i] ? shapePrimary(sortedHotels[i], 'hotel') : null;
    const alts = [];
    for (let j = 1; j <= altCount && i + j < sortedHotels.length; j++) {
      alts.push(shapeAlternative(sortedHotels[i + j], `评分${sortedHotels[i + j].props?.rating || 0}`));
    }
    hotelsByDay[`day${d}`] = { primary, alternatives: alts };
  }

  // 7. 查 events (传入节点 ID 列表)
  const allNodeIds = [
    ...primaryAttr.map((n) => n.id),
    ...lunchPrimary.map((n) => n.id),
    ...dinnerPrimary.map((n) => n.id),
    ...Object.values(hotelsByDay).map((h) => h.primary?.id).filter(Boolean),
  ];
  const events = await MockBackend.get_active_events(allNodeIds);

  const result = {
    city,
    attractions: {
      primary: primaryAttr,
      alternatives: altAttr,
    },
    restaurants: {
      lunch: {
        primary: lunchPrimary[0] || null,
        alternatives: lunchAlt,
      },
      dinner: {
        primary: dinnerPrimary[0] || null,
        alternatives: dinnerAlt,
      },
    },
    hotels: hotelsByDay,
    transport_hubs: transportHubs.map((n) => ({
      id: n.id, name: n.name, lat: n.lat, lng: n.lng, type: n.type,
      status: n.status, status_reason: n.status_reason,
    })),
    events,
    days,
    preference: { poi_types: mergedTypes, food_cuisine: mergedCuisine, shopping },
  };

  writeDebug('phase2_out.json', result);
  return result;
}

if (require.main === module) {
  const city = process.argv[2] || '北京';
  const prefJson = process.argv[3] || '{}';
  let preference = {};
  try { preference = JSON.parse(prefJson); } catch (_) { preference = {}; }

  run(city, preference)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[phase2_poi_filter] failed:', err);
      process.exit(1);
    });
}

module.exports = { run };
