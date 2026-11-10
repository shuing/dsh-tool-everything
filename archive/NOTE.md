# archive - 非运行文件

- index.js.bak-20261108T2140: 0.5.2 定义瘦身前 lib/components/everything/index.js 的快照。
  保留旧措辞(负 offset 参数错误 / countOnly 与正 offset 互斥 / type 与串内 file: folder: 撞车 / sort 缺省即 name 降序 / Everything 自有函数开放透传)仅为对照。
  不参与加载; package.json 的 files 白名单不含本目录, 不会被 pack。

- 2026-11-10 归置: 原先散落在运行目录的 13 个快照全部移入本目录
  （lib/components/everything/ 的 11 个 index.js.bak-*，以及 lib/shared/ 的 2 个
  format.mjs.bak-*）。连同原有的 index.js.bak-20261108T2140，本目录曾共 14 份快照。
  它们同样不参与加载、不进 pack 白名单; .gitignore 已加 `lib/**/*.bak*` 与
  `lib/*.bak*` 防止再次散落。

- 2026-11-10 去重: 归置后发现两组内容逐字节相同(仅文件名时间戳不同), 已各删一份,
  本目录现为 12 份快照, 哈希两两互不相同。保留的是时间戳较晚的那份:

    index.js.bak-cost-20261109T1010     保留  (删除了内容相同的 bak-diagnostic-20261109T0925)
    index.js.bak-nopoison2-20261109T1030 保留  (删除了内容相同的 bak-nopoison-20261109T1025)

  当前 12 份完整清单(哈希均唯一):
    format.mjs.bak-foldersize-20261109T0935      10416 B
    format.mjs.bak-pathcompact-20261110T0846     12320 B
    index.js.bak-20261108T2140                   54250 B  (0.5.2 定义瘦身前)
    index.js.bak-circuit-20261109T0800           54959 B
    index.js.bak-cost-20261109T1010              60479 B
    index.js.bak-costmove-20261109T1110          58767 B
    index.js.bak-errmsg-20261109T0915            61114 B
    index.js.bak-errmsgstar-20261109T0920        60776 B
    index.js.bak-exclude-20260909T0905           60852 B
    index.js.bak-excludefix-20261109T0908        61213 B
    index.js.bak-narrow-20261109T1055            58429 B
    index.js.bak-nopoison2-20261109T1030         62369 B
