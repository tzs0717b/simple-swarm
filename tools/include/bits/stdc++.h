// Termux 上没有 GNU libstdc++ 的 bits/stdc++.h（这里的 g++ 是 clang 的软链）。
// 这个 shim 让信奥风格的一行 #include <bits/stdc++.h> 能编译通过，
// 内容等同于常见实现在竞赛场景下提供的东西（含 using namespace std）。
// 由 swarm/tools/include/bits/stdc++.h 提供，经 CPLUS_INCLUDE_PATH 生效。
#pragma once
#include <iostream>
#include <iomanip>
#include <vector>
#include <string>
#include <algorithm>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <climits>
#include <cassert>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <queue>
#include <stack>
#include <deque>
#include <list>
#include <bitset>
#include <utility>
#include <tuple>
#include <numeric>
#include <functional>
#include <sstream>
#include <fstream>
#include <array>
#include <memory>
using namespace std;
