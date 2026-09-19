/*
 * 预置名字池：500 个常见英文名（统一小写）。
 *
 * 来源：https://github.com/hadley/data-baby-names （baby-names.csv，1880-2008 美国出生登记）
 * 处理：按各年份出现频率累加排序取前 500；只保留纯字母、长度 3-12；统一小写去重。
 *
 * 用途：创建 swarm 时按 agentCount 从池中抽取，名字写进每个 agent 的系统提示词。
 * 名字只是身份，不携带岗位或性格 —— 干什么活由运行时看板认领决定。
 */

export const NAME_POOL: string[] = [
  "john", "james", "mary", "william", "robert", "charles", "michael", "joseph", "david", "george",
  "thomas", "richard", "edward", "elizabeth", "margaret", "frank", "helen", "anna", "daniel", "paul",
  "dorothy", "donald", "christopher", "barbara", "patricia", "henry", "ruth", "walter", "linda", "kenneth",
  "jennifer", "betty", "sarah", "anthony", "matthew", "harry", "andrew", "willie", "arthur", "alice",
  "mark", "raymond", "nancy", "albert", "frances", "susan", "ronald", "steven", "marie", "laura",
  "emma", "martha", "brian", "catherine", "harold", "florence", "fred", "samuel", "rose", "virginia",
  "kevin", "joshua", "jack", "timothy", "grace", "jessica", "mildred", "jason", "karen", "lillian",
  "annie", "carol", "ethel", "carl", "shirley", "lisa", "joe", "sandra", "stephen", "gary",
  "jeffrey", "donna", "clarence", "louis", "roy", "larry", "katherine", "edna", "clara", "ralph",
  "amanda", "evelyn", "emily", "rebecca", "nicholas", "eric", "jacob", "louise", "benjamin", "kimberly",
  "kathleen", "bertha", "peter", "michelle", "ryan", "julia", "ashley", "jerry", "melissa", "lawrence",
  "sharon", "amy", "irene", "minnie", "scott", "patrick", "howard", "edith", "doris", "stephanie",
  "ernest", "ida", "jessie", "earl", "jonathan", "eugene", "deborah", "jean", "cynthia", "bessie",
  "angela", "ann", "josephine", "justin", "carolyn", "dennis", "christine", "gregory", "francis", "janet",
  "gladys", "jesse", "joan", "gertrude", "joyce", "ruby", "brandon", "hazel", "ella", "carrie",
  "rachel", "eva", "kathryn", "maria", "brenda", "douglas", "pearl", "mabel", "gerald", "alexander",
  "pamela", "nellie", "marion", "esther", "alfred", "nicole", "herbert", "kelly", "theresa", "lee",
  "lois", "jose", "judith", "heather", "myrtle", "diane", "aaron", "jane", "leonard", "charlie",
  "elsie", "adam", "russell", "roger", "terry", "julie", "debra", "sara", "agnes", "christina",
  "gloria", "stanley", "frederick", "lillie", "nathan", "eleanor", "samantha", "ellen", "billy", "leslie",
  "anne", "victoria", "philip", "martin", "tyler", "pauline", "beverly", "marilyn", "janice", "marjorie",
  "mattie", "thelma", "lucille", "phyllis", "teresa", "charlotte", "jacqueline", "norman", "edwin", "keith",
  "wayne", "cora", "oscar", "zachary", "beatrice", "cheryl", "lucy", "lena", "jennie", "judy",
  "elmer", "bruce", "kyle", "alma", "lauren", "theodore", "ray", "hannah", "norma", "andrea",
  "bonnie", "leo", "megan", "jeremy", "hattie", "victor", "vincent", "leroy", "allen", "jordan",
  "melvin", "sam", "rosa", "viola", "bobby", "stella", "bernard", "marvin", "eddie", "rita",
  "herman", "floyd", "sean", "bernice", "lewis", "clyde", "clifford", "taylor", "sylvia", "peggy",
  "denise", "diana", "phillip", "mae", "dale", "wanda", "amber", "glenn", "shannon", "austin",
  "danielle", "katie", "jamie", "johnny", "bryan", "blanche", "lula", "ada", "alan", "christian",
  "lori", "tammy", "brittany", "crystal", "fannie", "juan", "tiffany", "dora", "curtis", "lloyd",
  "elaine", "kathy", "tracy", "jimmy", "robin", "shawn", "dolores", "alexis", "maggie", "maude",
  "juanita", "nora", "tom", "geraldine", "caroline", "chester", "daisy", "alex", "audrey", "erin",
  "jim", "connie", "mamie", "tina", "georgia", "randy", "vera", "lester", "edgar", "leon",
  "dawn", "paula", "vivian", "steve", "warren", "sally", "craig", "natalie", "harvey", "travis",
  "olivia", "loretta", "lorraine", "kayla", "tony", "johnnie", "june", "alvin", "bradley", "claude",
  "danny", "todd", "anita", "lydia", "isaac", "courtney", "madison", "wesley", "leona", "wendy",
  "joel", "cecil", "lynn", "carlos", "nathaniel", "calvin", "sadie", "mike", "rodney", "vernon",
  "monica", "will", "veronica", "joanne", "dana", "susie", "milton", "bill", "sheila", "gordon",
  "allison", "alyssa", "valerie", "dylan", "cody", "manuel", "cindy", "antonio", "marian", "roberta",
  "ben", "beulah", "chad", "eileen", "gail", "april", "suzanne", "don", "ethan", "wilma",
  "jay", "jeanette", "sherry", "angel", "gabriel", "marguerite", "abigail", "darlene", "noah", "luis",
  "michele", "erica", "vanessa", "della", "maurice", "morgan", "troy", "alicia", "jimmie", "violet",
  "gilbert", "marcus", "regina", "harriet", "madeline", "jerome", "sophia", "kristen", "jeffery", "franklin",
  "melanie", "jill", "flora", "jeanne", "may", "effie", "nettie", "cameron", "sidney", "hugh",
  "luther", "nina", "leah", "rhonda", "tommy", "amelia", "logan", "annette", "guy", "sue",
  "ollie", "kim", "derek", "jesus", "jasmine", "genevieve", "ricky", "homer", "everett", "rosemary",
  "naomi", "brianna", "holly", "randall", "arlene", "hilda", "billie", "sallie", "max", "glen",
  "alexandra", "joann", "stacy", "dean", "evan", "oliver", "gene", "jackie", "ronnie", "dustin",
  "renee", "yvonne", "lola", "claire", "constance", "luke", "adrian", "arnold", "barry", "kristin",
  "velma", "elijah", "dan", "olive", "patsy", "lottie", "carmen", "tara", "jared", "eunice",
];

/** 池大小 */
export const NAME_POOL_SIZE = NAME_POOL.length;

/**
 * 从池中取 count 个互不重复的名字（同一种子结果确定）。
 */
/* 保留字（邮箱的共享 local）绝不能作为智能体名字出现 */
const RESERVED = ["human", "system", "board", "all", "agents", "humans"];

function pickable(): string[] {
  return NAME_POOL.filter((name) => !RESERVED.includes(name));
}

export function pickNames(count: number, seed = Date.now()): string[] {
  const pool = pickable();
  const picked: string[] = [];
  let state = seed >>> 0;
  for (let i = 0; i < count; i += 1) {
    if (pool.length === 0) pool.push(...pickable()); // 池子被抽空时重填（实际不会发生）
    state = (state * 1664525 + 1013904223) >>> 0;
    picked.push(pool.splice(state % pool.length, 1)[0]);
  }
  return picked;
}

