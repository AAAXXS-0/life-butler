-- =============================================
-- Mock Backend 建表 + 北京子图 Mock 数据
-- 库名：life_butler_db
-- 状态：随 docker-compose 启动自动执行
-- 更新时间：2026-06-06
-- =============================================

-- 库已由 docker-compose 创建（life_butler_db），USE 切过来
USE life_butler_db;

-- =============================================
-- 表1：nodes（图节点）
-- =============================================
CREATE TABLE IF NOT EXISTS nodes (
  id         VARCHAR(32) PRIMARY KEY,
  type       ENUM('attraction','restaurant','hotel','transport_hub') NOT NULL,
  name       VARCHAR(128) NOT NULL,
  lat        DOUBLE NOT NULL,
  lng        DOUBLE NOT NULL,
  props      JSON,
  queue_count INT NOT NULL DEFAULT 0,           -- 餐厅/景点当前排队人数
  is_indoor  TINYINT(1) NOT NULL DEFAULT 0,     -- 是否室内（天气恶劣时切换用）
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 城市筛选索引（MySQL 9.7+ 需 CAST JSON 表达式）
CREATE INDEX idx_nodes_city ON nodes((CAST(JSON_UNQUOTE(JSON_EXTRACT(props, '$.city')) AS CHAR(64))));
CREATE INDEX idx_nodes_type_city ON nodes(type, (CAST(JSON_UNQUOTE(JSON_EXTRACT(props, '$.city')) AS CHAR(64))));

-- =============================================
-- 表2：edges（图边）
-- =============================================
CREATE TABLE IF NOT EXISTS edges (
  id             VARCHAR(32) PRIMARY KEY,
  from_node      VARCHAR(32) NOT NULL,
  to_node        VARCHAR(32) NOT NULL,
  type           ENUM('walk','metro','drive') NOT NULL,
  distance_m     INT NOT NULL,
  duration_min   INT NOT NULL,
  metro_line     VARCHAR(32),
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_node) REFERENCES nodes(id),
  FOREIGN KEY (to_node) REFERENCES nodes(id)
);

CREATE INDEX idx_edges_from ON edges(from_node);
CREATE INDEX idx_edges_to ON edges(to_node);

-- =============================================
-- 表3：node_status（节点动态状态）
-- =============================================
CREATE TABLE IF NOT EXISTS node_status (
  node_id    VARCHAR(32) PRIMARY KEY,
  status     ENUM('open','full','closed','limited') DEFAULT 'open',
  reason     VARCHAR(256),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

-- =============================================
-- 表4：edge_status（边动态状态）
-- =============================================
CREATE TABLE IF NOT EXISTS edge_status (
  edge_id    VARCHAR(32) PRIMARY KEY,
  status     ENUM('open','congested','closed') DEFAULT 'open',
  reason     VARCHAR(256),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (edge_id) REFERENCES edges(id)
);

-- =============================================
-- 表5：events（事件记录）
-- =============================================
CREATE TABLE IF NOT EXISTS events (
  id           VARCHAR(32) PRIMARY KEY,
  type         TINYINT NOT NULL,    -- 1=天气转晴 2=天气转雨 3=天气转沙尘暴 4=天气转台风 5=排队+ 6=排队- 7=POI限流 8=餐厅满座 9=道路封闭 10=交通拥堵 11=地铁延误 12=no_op
  target_type  ENUM('node','edge','city') NOT NULL,
  target_id    VARCHAR(32) NOT NULL,
  severity     ENUM('low','medium','high') NOT NULL,
  is_good      TINYINT(1) NOT NULL DEFAULT 0,  -- 标记好事（detector 过滤用）
  title        VARCHAR(256),
  detail       TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_events_created ON events(created_at);

-- =============================================
-- 表6：weather（全市级天气）
-- =============================================
CREATE TABLE IF NOT EXISTS weather (
  city        VARCHAR(32) PRIMARY KEY,
  status      ENUM('sunny','rainy','sandstorm','typhoon') NOT NULL,
  temperature INT,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO weather (city, status, temperature) VALUES
('北京', 'sunny', 22)
ON DUPLICATE KEY UPDATE status = 'sunny', temperature = 22, updated_at = NOW();
-- 北京子图 Mock 数据
-- 范围：东城/西城/朝阳/海淀 核心区
-- =============================================

-- 景点（25 个）
INSERT INTO nodes (id, type, name, lat, lng, props, queue_count, is_indoor) VALUES
('attr_001','attraction','故宫',39.9163,116.3972, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('博物馆','世界遗产','必去'),'rating',4.8,'duration_estimate',180,'ticket_price',60,'nearest_metro','天安门东'), 0, 0),
('attr_002','attraction','天坛',39.8827,116.4128, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('世界遗产','公园'),'rating',4.6,'duration_estimate',150,'ticket_price',35,'nearest_metro','天坛东门'), 0, 0),
('attr_003','attraction','颐和园',39.9998,116.2755, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('园林','世界遗产'),'rating',4.7,'duration_estimate',240,'ticket_price',30,'nearest_metro','北宫门'), 0, 0),
('attr_004','attraction','圆明园',40.0083,116.2988, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('遗址','园林'),'rating',4.5,'duration_estimate',180,'ticket_price',10,'nearest_metro','圆明园'), 0, 0),
('attr_005','attraction','北海公园',39.9249,116.3876, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('皇家园林','白塔'),'rating',4.5,'duration_estimate',120,'ticket_price',10,'nearest_metro','北海北'), 0, 0),
('attr_006','attraction','景山公园',39.9254,116.3969, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('俯瞰故宫'),'rating',4.4,'duration_estimate',60,'ticket_price',2,'nearest_metro','景山东街'), 0, 0),
('attr_007','attraction','国家博物馆',39.9054,116.3949, JSON_OBJECT('city','北京','category','博物馆','tags',JSON_ARRAY('室内','文物'),'rating',4.9,'duration_estimate',180,'ticket_price',0,'nearest_metro','天安门东'), 0, 0),
('attr_008','attraction','首都博物馆',39.9089,116.3380, JSON_OBJECT('city','北京','category','博物馆','tags',JSON_ARRAY('室内','历史'),'rating',4.6,'duration_estimate',150,'ticket_price',0,'nearest_metro','白云路'), 0, 0),
('attr_009','attraction','798艺术区',39.9839,116.4969, JSON_OBJECT('city','北京','category','艺术区','tags',JSON_ARRAY('艺术','拍照','网红'),'rating',4.5,'duration_estimate',180,'ticket_price',0,'nearest_metro','望京南'), 0, 0),
('attr_010','attraction','南锣鼓巷',39.9377,116.4036, JSON_OBJECT('city','北京','category','胡同','tags',JSON_ARRAY('小吃','文艺','人多'),'rating',4.3,'duration_estimate',120,'ticket_price',0,'nearest_metro','南锣鼓巷'), 0, 0),
('attr_011','attraction','什刹海',39.9408,116.3875, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('酒吧','夜景','滑冰'),'rating',4.5,'duration_estimate',120,'ticket_price',0,'nearest_metro','什刹海'), 0, 0),
('attr_012','attraction','雍和宫',39.9471,116.4167, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('寺庙','藏传佛教'),'rating',4.6,'duration_estimate',90,'ticket_price',25,'nearest_metro','雍和宫'), 0, 0),
('attr_013','attraction','国子监',39.9437,116.4136, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('孔庙','古代学府'),'rating',4.4,'duration_estimate',60,'ticket_price',30,'nearest_metro','雍和宫'), 0, 0),
('attr_014','attraction','王府井',39.9135,116.4106, JSON_OBJECT('city','北京','category','商业街','tags',JSON_ARRAY('购物','小吃'),'rating',4.2,'duration_estimate',120,'ticket_price',0,'nearest_metro','王府井'), 0, 0),
('attr_015','attraction','三里屯',39.9362,116.4547, JSON_OBJECT('city','北京','category','商业街','tags',JSON_ARRAY('酒吧','购物','时尚'),'rating',4.4,'duration_estimate',180,'ticket_price',0,'nearest_metro','团结湖'), 0, 0),
('attr_016','attraction','后海',39.9413,116.3815, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('夜景','酒吧'),'rating',4.5,'duration_estimate',120,'ticket_price',0,'nearest_metro','鼓楼大街'), 0, 0),
('attr_017','attraction','朝阳公园',39.9387,116.4760, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('大','游乐场'),'rating',4.4,'duration_estimate',180,'ticket_price',5,'nearest_metro','枣营'), 0, 0),
('attr_018','attraction','奥林匹克公园',40.0026,116.3905, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('鸟巢','水立方','奥运'),'rating',4.6,'duration_estimate',180,'ticket_price',0,'nearest_metro','奥林匹克公园'), 0, 0),
('attr_019','attraction','香山公园',39.9993,116.1880, JSON_OBJECT('city','北京','category','公园','tags',JSON_ARRAY('红叶','爬山'),'rating',4.5,'duration_estimate',240,'ticket_price',10,'nearest_metro','香山'), 0, 0),
('attr_020','attraction','八达岭长城',40.3598,116.0240, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('世界遗产','必去','远'),'rating',4.7,'duration_estimate',360,'ticket_price',40,'nearest_metro',NULL), 0, 0),
('attr_021','attraction','明十三陵',40.2995,116.2353, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('陵墓','世界遗产'),'rating',4.4,'duration_estimate',240,'ticket_price',45,'nearest_metro',NULL), 0, 0),
('attr_022','attraction','恭王府',39.9358,116.3850, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('王府','和珅'),'rating',4.5,'duration_estimate',120,'ticket_price',40,'nearest_metro','北海北'), 0, 0),
('attr_023','attraction','天安门广场',39.9054,116.3976, JSON_OBJECT('city','北京','category','广场','tags',JSON_ARRAY('升旗','必去'),'rating',4.7,'duration_estimate',60,'ticket_price',0,'nearest_metro','天安门东'), 0, 0),
('attr_024','attraction','毛主席纪念堂',39.9050,116.3970, JSON_OBJECT('city','北京','category','历史遗迹','tags',JSON_ARRAY('纪念堂'),'rating',4.5,'duration_estimate',30,'ticket_price',0,'nearest_metro','天安门东'), 0, 0),
('attr_025','attraction','大栅栏',39.8974,116.3935, JSON_OBJECT('city','北京','category','商业街','tags',JSON_ARRAY('老字号','小吃'),'rating',4.2,'duration_estimate',90,'ticket_price',0,'nearest_metro','大栅栏'), 0, 0);

-- 餐厅（15 个）
INSERT INTO nodes (id, type, name, lat, lng, props, queue_count, is_indoor) VALUES
('rest_001','restaurant','全聚德',39.9142,116.4119, JSON_OBJECT('city','北京','category','北京菜','人均',200,'hours','10:00-22:00','rating',4.7,'tags',JSON_ARRAY('烤鸭','老字号')), 0, 1),
('rest_002','restaurant','东来顺',39.9218,116.4182, JSON_OBJECT('city','北京','category','涮羊肉','人均',180,'hours','11:00-22:00','rating',4.6,'tags',JSON_ARRAY('火锅','老字号')), 0, 1),
('rest_003','restaurant','便宜坊',39.9153,116.4083, JSON_OBJECT('city','北京','category','北京菜','人均',220,'hours','10:00-21:30','rating',4.6,'tags',JSON_ARRAY('烤鸭','焖炉')), 0, 1),
('rest_004','restaurant','海底捞',39.9123,116.4125, JSON_OBJECT('city','北京','category','火锅','人均',150,'hours','10:00-02:00','rating',4.7,'tags',JSON_ARRAY('服务好','排队')), 0, 1),
('rest_005','restaurant','簋街小龙虾',39.9385,116.4195, JSON_OBJECT('city','北京','category','川菜','人均',180,'hours','17:00-03:00','rating',4.5,'tags',JSON_ARRAY('小龙虾','夜宵')), 0, 1),
('rest_006','restaurant','西单大悦城',39.9093,116.3735, JSON_OBJECT('city','北京','category','综合','人均',100,'hours','10:00-22:00','rating',4.3,'tags',JSON_ARRAY('购物中心','多选择')), 0, 1),
('rest_007','restaurant','护国寺小吃',39.9359,116.3869, JSON_OBJECT('city','北京','category','小吃','人均',40,'hours','06:00-21:00','rating',4.4,'tags',JSON_ARRAY('豆汁','传统')), 0, 1),
('rest_008','restaurant','姚记炒肝',39.9395,116.4073, JSON_OBJECT('city','北京','category','小吃','人均',50,'hours','06:00-20:30','rating',4.3,'tags',JSON_ARRAY('炒肝','老北京')), 0, 1),
('rest_009','restaurant','九门小吃',39.9388,116.3992, JSON_OBJECT('city','北京','category','小吃','人均',60,'hours','10:00-22:00','rating',4.4,'tags',JSON_ARRAY('老北京','汇聚')), 0, 1),
('rest_010','restaurant','四季民福',39.9118,116.3935, JSON_OBJECT('city','北京','category','北京菜','人均',250,'hours','11:00-22:00','rating',4.8,'tags',JSON_ARRAY('烤鸭','景观')), 0, 1),
('rest_011','restaurant','大董烤鸭',39.9188,116.4508, JSON_OBJECT('city','北京','category','北京菜','人均',300,'hours','11:00-22:00','rating',4.8,'tags',JSON_ARRAY('烤鸭','高端')), 0, 1),
('rest_012','restaurant','庆丰包子铺',39.9162,116.4042, JSON_OBJECT('city','北京','category','小吃','人均',30,'hours','06:00-21:00','rating',4.0,'tags',JSON_ARRAY('包子','平价')), 0, 1),
('rest_013','restaurant','外婆家',39.9241,116.4358, JSON_OBJECT('city','北京','category','江浙菜','人均',80,'hours','10:30-21:30','rating',4.5,'tags',JSON_ARRAY('杭帮菜','排队')), 0, 1),
('rest_014','restaurant','南京大牌档',39.9282,116.4351, JSON_OBJECT('city','北京','category','江浙菜','人均',90,'hours','10:00-22:00','rating',4.6,'tags',JSON_ARRAY('民国风','多菜')), 0, 1),
('rest_015','restaurant','局气',39.9287,116.4358, JSON_OBJECT('city','北京','category','北京菜','人均',120,'hours','11:00-22:00','rating',4.5,'tags',JSON_ARRAY('创意','京味')), 0, 1);

-- 酒店（8 个）
INSERT INTO nodes (id, type, name, lat, lng, props, queue_count, is_indoor) VALUES
('hotel_001','hotel','王府半岛酒店',39.9154,116.4103, JSON_OBJECT('city','北京','district','王府井','price',1500,'stars',5,'rating',4.8), 0, 1),
('hotel_002','hotel','北京饭店',39.9130,116.4105, JSON_OBJECT('city','北京','district','王府井','price',1200,'stars',5,'rating',4.7), 0, 1),
('hotel_003','hotel','东方君悦',39.9120,116.4110, JSON_OBJECT('city','北京','district','王府井','price',1800,'stars',5,'rating',4.9), 0, 1),
('hotel_004','hotel','如家精选',39.9395,116.4070, JSON_OBJECT('city','北京','district','南锣鼓巷','price',400,'stars',3,'rating',4.3), 0, 1),
('hotel_005','hotel','汉庭',39.9218,116.4358, JSON_OBJECT('city','北京','district','三里屯','price',350,'stars',2,'rating',4.1), 0, 1),
('hotel_006','hotel','亚朵',39.9412,116.4536, JSON_OBJECT('city','北京','district','三里屯','price',600,'stars',3,'rating',4.6), 0, 1),
('hotel_007','hotel','希尔顿',39.9111,116.4112, JSON_OBJECT('city','北京','district','王府井','price',2000,'stars',5,'rating',4.7), 0, 1),
('hotel_008','hotel','全季',39.9404,116.4073, JSON_OBJECT('city','北京','district','南锣鼓巷','price',500,'stars',3,'rating',4.5), 0, 1);

-- 交通枢纽（4 个）
INSERT INTO nodes (id, type, name, lat, lng, props, queue_count, is_indoor) VALUES
('hub_001','transport_hub','北京南站',39.8652,116.3783, JSON_OBJECT('city','北京','lines',JSON_ARRAY('高铁','地铁4号线')), 0, 1),
('hub_002','transport_hub','北京西站',39.8949,116.3219, JSON_OBJECT('city','北京','lines',JSON_ARRAY('高铁','地铁7号线','地铁9号线')), 0, 1),
('hub_003','transport_hub','北京站',39.9023,116.4270, JSON_OBJECT('city','北京','lines',JSON_ARRAY('高铁','地铁2号线')), 0, 1),
('hub_004','transport_hub','首都机场',40.0801,116.5846, JSON_OBJECT('city','北京','lines',JSON_ARRAY('机场快线','飞机')), 0, 1);

-- 节点初始状态（全部 open）
INSERT INTO node_status (node_id, status) VALUES
('attr_001','open'),('attr_002','open'),('attr_003','open'),('attr_004','open'),('attr_005','open'),
('attr_006','open'),('attr_007','open'),('attr_008','open'),('attr_009','open'),('attr_010','open'),
('attr_011','open'),('attr_012','open'),('attr_013','open'),('attr_014','open'),('attr_015','open'),
('attr_016','open'),('attr_017','open'),('attr_018','open'),('attr_019','open'),('attr_020','open'),
('attr_021','open'),('attr_022','open'),('attr_023','open'),('attr_024','open'),('attr_025','open'),
('rest_001','open'),('rest_002','open'),('rest_003','open'),('rest_004','open'),('rest_005','open'),
('rest_006','open'),('rest_007','open'),('rest_008','open'),('rest_009','open'),('rest_010','open'),
('rest_011','open'),('rest_012','open'),('rest_013','open'),('rest_014','open'),('rest_015','open'),
('hotel_001','open'),('hotel_002','open'),('hotel_003','open'),('hotel_004','open'),
('hotel_005','open'),('hotel_006','open'),('hotel_007','open'),('hotel_008','open'),
('hub_001','open'),('hub_002','open'),('hub_003','open'),('hub_004','open');

-- =============================================
-- 边（walk + metro + drive，~80 条）
-- =============================================

-- 步行边（500m 以内，~25 条）
INSERT INTO edges (id, from_node, to_node, type, distance_m, duration_min) VALUES
('edge_w001','attr_001','attr_023', 'walk', 600, 8),
('edge_w002','attr_023','attr_024', 'walk', 200, 3),
('edge_w003','attr_023','attr_007', 'walk', 300, 4),
('edge_w004','attr_001','attr_006', 'walk', 700, 10),
('edge_w005','attr_006','attr_005', 'walk', 400, 6),
('edge_w006','attr_001','attr_014', 'walk', 800, 12),
('edge_w007','attr_001','attr_022', 'walk', 1500, 22),
('edge_w008','attr_022','attr_005', 'walk', 500, 8),
('edge_w009','attr_011','attr_016', 'walk', 600, 9),
('edge_w010','attr_011','attr_010', 'walk', 1000, 15),
('edge_w011','attr_010','attr_009', 'walk', 800, 12),
('edge_w012','attr_012','attr_013', 'walk', 500, 7),
('edge_w013','attr_014','hotel_001', 'walk', 300, 5),
('edge_w014','attr_014','hotel_002', 'walk', 400, 6),
('edge_w015','hotel_001','hotel_002', 'walk', 200, 3),
('edge_w016','hotel_001','hotel_003', 'walk', 350, 5),
('edge_w017','hotel_002','hotel_007', 'walk', 250, 4),
('edge_w018','attr_010','hotel_004', 'walk', 400, 6),
('edge_w019','attr_010','hotel_008', 'walk', 300, 5),
('edge_w020','attr_015','hotel_005', 'walk', 600, 9),
('edge_w021','attr_015','hotel_006', 'walk', 400, 6),
('edge_w022','rest_001','attr_014', 'walk', 400, 6),
('edge_w023','rest_010','attr_001', 'walk', 500, 8),
('edge_w024','rest_003','attr_014', 'walk', 350, 5),
('edge_w025','attr_025','attr_023', 'walk', 800, 12);

-- 地铁边（~30 条，覆盖主要线路连接）
INSERT INTO edges (id, from_node, to_node, type, distance_m, duration_min, metro_line) VALUES
('edge_m001','attr_001','hub_003', 'metro', 3500, 12, '1号线'),
('edge_m002','attr_001','attr_018', 'metro', 12000, 35, '1号线-8号线'),
('edge_m003','attr_018','attr_019', 'metro', 30000, 50, '西郊线'),
('edge_m004','attr_003','attr_018', 'metro', 15000, 40, '4号线'),
('edge_m005','attr_001','attr_010', 'metro', 4000, 15, '6号线'),
('edge_m006','attr_010','attr_015', 'metro', 8000, 25, '6号线'),
('edge_m007','attr_015','attr_017', 'metro', 4000, 12, '14号线'),
('edge_m008','attr_011','attr_015', 'metro', 7000, 22, '8号线'),
('edge_m009','attr_011','attr_010', 'metro', 2500, 10, '8号线-6号线'),
('edge_m010','attr_010','attr_012', 'metro', 3000, 10, '5号线-2号线'),
('edge_m011','attr_012','attr_014', 'metro', 3000, 11, '5号线-1号线'),
('edge_m012','attr_002','attr_001', 'metro', 8000, 25, '5号线-1号线'),
('edge_m013','attr_009','attr_015', 'metro', 6000, 18, '14号线'),
('edge_m014','attr_014','attr_006', 'metro', 2500, 9, '1号线'),
('edge_m015','attr_006','attr_001', 'metro', 1200, 5, '1号线'),
('edge_m016','attr_001','attr_002', 'metro', 8500, 26, '1号线-5号线'),
('edge_m017','attr_017','attr_018', 'metro', 9000, 28, '14号线-8号线'),
('edge_m018','attr_018','attr_014', 'metro', 15000, 42, '8号线-1号线'),
('edge_m019','attr_015','attr_001', 'metro', 12000, 35, '6号线-2号线-1号线'),
('edge_m020','attr_011','attr_001', 'metro', 5500, 18, '8号线-1号线'),
('edge_m021','attr_011','attr_014', 'metro', 5000, 16, '8号线-1号线'),
('edge_m022','attr_011','attr_016', 'metro', 2000, 7, '8号线'),
('edge_m023','attr_010','attr_011', 'metro', 2500, 10, '6号线-8号线'),
('edge_m024','attr_010','attr_014', 'metro', 4500, 14, '6号线-1号线'),
('edge_m025','attr_010','attr_001', 'metro', 4000, 13, '6号线-1号线'),
('edge_m026','attr_014','attr_001', 'metro', 3500, 11, '1号线'),
('edge_m027','attr_014','attr_013', 'metro', 4000, 14, '1号线-5号线-2号线'),
('edge_m028','attr_012','attr_002', 'metro', 5500, 18, '5号线'),
('edge_m029','hub_001','attr_001', 'metro', 9000, 28, '4号线-1号线'),
('edge_m030','hub_002','attr_001', 'metro', 12000, 36, '7号线-4号线-1号线');

-- 驾车/打车边（~25 条，跨区或长距离）
INSERT INTO edges (id, from_node, to_node, type, distance_m, duration_min) VALUES
('edge_d001','attr_001','attr_009', 'drive', 18000, 35),
('edge_d002','attr_001','attr_015', 'drive', 12000, 30),
('edge_d003','attr_001','attr_017', 'drive', 14000, 32),
('edge_d004','attr_001','attr_018', 'drive', 16000, 35),
('edge_d005','attr_001','attr_003', 'drive', 20000, 40),
('edge_d006','attr_001','attr_019', 'drive', 30000, 55),
('edge_d007','attr_001','attr_020', 'drive', 60000, 75),
('edge_d008','attr_001','attr_021', 'drive', 45000, 65),
('edge_d009','attr_015','attr_017', 'drive', 5000, 12),
('edge_d010','attr_015','attr_009', 'drive', 8000, 18),
('edge_d011','attr_018','attr_019', 'drive', 25000, 45),
('edge_d012','attr_018','attr_003', 'drive', 12000, 25),
('edge_d013','attr_018','attr_020', 'drive', 55000, 70),
('edge_d014','attr_014','attr_015', 'drive', 6000, 18),
('edge_d015','attr_014','attr_009', 'drive', 14000, 30),
('edge_d016','attr_010','attr_009', 'drive', 9000, 20),
('edge_d017','attr_011','attr_009', 'drive', 12000, 25),
('edge_d018','attr_011','attr_015', 'drive', 7000, 18),
('edge_d019','attr_011','attr_017', 'drive', 9000, 22),
('edge_d020','attr_001','hub_001', 'drive', 10000, 25),
('edge_d021','attr_001','hub_002', 'drive', 12000, 30),
('edge_d022','attr_001','hub_003', 'drive', 4000, 12),
('edge_d023','attr_001','hub_004', 'drive', 28000, 45),
('edge_d024','attr_018','hub_001', 'drive', 18000, 35),
('edge_d025','attr_018','hub_004', 'drive', 35000, 55);

-- 边初始状态（全部 open）
INSERT INTO edge_status (edge_id, status) VALUES
('edge_w001','open'),('edge_w002','open'),('edge_w003','open'),('edge_w004','open'),('edge_w005','open'),
('edge_w006','open'),('edge_w007','open'),('edge_w008','open'),('edge_w009','open'),('edge_w010','open'),
('edge_w011','open'),('edge_w012','open'),('edge_w013','open'),('edge_w014','open'),('edge_w015','open'),
('edge_w016','open'),('edge_w017','open'),('edge_w018','open'),('edge_w019','open'),('edge_w020','open'),
('edge_w021','open'),('edge_w022','open'),('edge_w023','open'),('edge_w024','open'),('edge_w025','open'),
('edge_m001','open'),('edge_m002','open'),('edge_m003','open'),('edge_m004','open'),('edge_m005','open'),
('edge_m006','open'),('edge_m007','open'),('edge_m008','open'),('edge_m009','open'),('edge_m010','open'),
('edge_m011','open'),('edge_m012','open'),('edge_m013','open'),('edge_m014','open'),('edge_m015','open'),
('edge_m016','open'),('edge_m017','open'),('edge_m018','open'),('edge_m019','open'),('edge_m020','open'),
('edge_m021','open'),('edge_m022','open'),('edge_m023','open'),('edge_m024','open'),('edge_m025','open'),
('edge_m026','open'),('edge_m027','open'),('edge_m028','open'),('edge_m029','open'),('edge_m030','open'),
('edge_d001','open'),('edge_d002','open'),('edge_d003','open'),('edge_d004','open'),('edge_d005','open'),
('edge_d006','open'),('edge_d007','open'),('edge_d008','open'),('edge_d009','open'),('edge_d010','open'),
('edge_d011','open'),('edge_d012','open'),('edge_d013','open'),('edge_d014','open'),('edge_d015','open'),
('edge_d016','open'),('edge_d017','open'),('edge_d018','open'),('edge_d019','open'),('edge_d020','open'),
('edge_d021','open'),('edge_d022','open'),('edge_d023','open'),('edge_d024','open'),('edge_d025','open');

-- =============================================
-- 数据统计
-- =============================================
-- nodes:       25 attraction + 15 restaurant + 8 hotel + 4 transport_hub = 52
-- edges:       25 walk + 30 metro + 25 drive = 80
-- node_status: 52
-- edge_status: 80
-- events:      0（运行时由 event_generator.js 填充）
