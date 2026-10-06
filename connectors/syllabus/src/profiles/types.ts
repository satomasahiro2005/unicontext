/**
 * Deployment profile of a LiveCampusU installation (§26): everything that differs between
 * universities lives here (or in config / `ctx.profile.products[<product>]`), never in the
 * strategy or normalizer code.
 */
export interface LcuScreens {
  /** Public syllabus search screen, e.g. "SC_06001B00_21". */
  syllabusSearch: string;
  /** Public syllabus detail screen, e.g. "SC_06001B00_22". */
  syllabusDetail: string;
  /** Public cancellation notice screen, e.g. "SC_90002szu_01". */
  publicCancellations: string;
}

/** Search form `title` values: academic year -> faculty code -> form value (e.g. 2026 / IN-B -> 2243). */
export type TitleCodes = Record<string, Record<string, string>>;

export interface LcuDeployment {
  id: string;
  /** Site root of the LCU web app including a trailing slash. */
  baseUrl: string;
  screens: LcuScreens;
  titles: TitleCodes;
  /**
   * Faculty code -> faculty code of the general education (全学教育) catalog taught on its campus,
   * e.g. IN-B -> LA-H (Hamamatsu). Lets a catalog of one faculty include the courses its students
   * actually take next to their own faculty's.
   */
  generalEducation?: Record<string, string>;
}
