// Southern hemisphere gets a 10,000km 'false northing' offset.
const FALSE_NORTHING = 10000000;

// MGRS squares are 100,000 x 100,000 m.
const M_PER_MGRS_SQUARE = 100000;

// Latitude Band IDs start from 'C' (i.e. omit 'A' & 'B')
const LAT_BAND_ID_TO_MGRS_LETTER_ID_OFFSET = 2;

// Number of unique letters for MGRS column identifiers (A-Z, omitting I and O).
const NUMBER_MGRS_COLUMN_LETTERS = 24;

// Number of unique letters for MGRS row identifiers (A-V, omitting I and O).
const NUMBER_MGRS_ROW_LETTERS = 20;

// Letters exclude I and O.
// We often convert between an index number (e.g. 0-24) and actual letter.
const MGRS_LETTER = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
];

const MGRS_LETTER_ID = [
  0, 1, 2, 3, 4, 5, 6, 7, -1, 8, 9, 10, 11, 12, -1, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23,
];

// The latitude band letters C-X (~I,O) form numbers 0-20.
// Store the mapping from latitude band number to northing coordinate (m) of
// the southern border.
// This lets us avoid a needless runtime northing-to-latitude conversion.
// Note: no false northing applied (so the array is sorted).
// Does not include polar regions (they don't use UTM northing).
const BAND_NORTHING = [
  -8883084.95594830438, // -80 deg (C)
  -7991508.54271004162,
  -7100467.04938164819,
  -6210141.32687210384,
  -5320655.78919156827,
  -4432069.0568985166,
  -3544369.9095386248,
  -2657478.70944542065,
  -1771254.01828129962,
  -885503.759297154844,
  0.0,
  885503.759297154145,
  1771254.018281299155,
  2657478.709445421118,
  3544369.909538624808,
  4432069.056898516603,
  5320655.78919156827,
  6210141.326872103848,
  7100467.04938164819,
  7991508.542710041627, // 72 deg (X)
];

// semi-major axis (m)
// eslint-disable-next-line no-unused-vars
const a = 6378137;

// inverse flattening
const f = 1.0 / 298.257222101;

class Mgrs {
  northing_to_lat_band(northing, has_false_northing) {
    // remove any false northing
    if (has_false_northing) {
      northing -= FALSE_NORTHING;
    }

    var it = LowerBound(BAND_NORTHING, northing, 0, BAND_NORTHING.length - 1);
    //std::lower_bound(BAND_NORTHING.begin(), BAND_NORTHING.end(), northing);
    var lat_band_id = (it - BAND_NORTHING[0]) - 1;
    if (lat_band_id < 0) {
      throw new Error('northing_to_band_id(): northing out of range (polar)');
    }
    // Safe Cast: if negative, the exception above is thrown.
    return MGRS_LETTER[lat_band_id + LAT_BAND_ID_TO_MGRS_LETTER_ID_OFFSET];
  }

  modulo(a, b) {
    const result = a % b;
    return result >= 0 ? result : result + b;
  }

  mgrs_square_origin(square) {
    this.validate(square);

    const column_start = ((square.utm_zone - 1) % 3) * 8;
    // Safe Cast: 'square.column' will always be at least 'A' because it is assigned from 'MGRS_LETTER'
    const column_id = MGRS_LETTER_ID[square.column - 'A'.charCodeAt(0)];

    const easting_index = column_id - column_start;

    // This is done to support a provided square.column outside the square.utm_zone. Although this is not expected to occur
    // in typical usage support is provided.
    // If square.column is not within the square.utm_zone the resulting easting will be relative to the provided UTM Zone
    // (square.utm_zone). For example extending West beyond the limits of the UTM zone will produce negative easting values while
    // extending East beyond the limits of the UTM zone will produce positive easting values.
    const easting_offset =
      easting_index > NUMBER_MGRS_COLUMN_LETTERS / 2
        ? -NUMBER_MGRS_COLUMN_LETTERS
        : 0;

    // Note: index starts at 100km (index + 1)
    const easting_origin = (easting_index + 1 + easting_offset) * M_PER_MGRS_SQUARE;

    // First MGRS square north of the equator is,
    //      - 'A' (0) for odd UTM zones,
    //      - 'F' (5) for even UTM zones
    // square row / northing_origin.
    const row_start = square.utm_zone % 2 == 0 ? 5 : 0;

    // Calculate the northing of the southern edge of the latitude band in which this cell resides.
    // Safe Cast: 'square.lat_band' will always be at least 'A' because it is assigned from 'MGRS_LETTER'
    const letter_id = MGRS_LETTER_ID[square.lat_band - 'A'.charCodeAt(0)];

    // Correct for UTM zones starting from 'C', not 'A'.
    // Safe Cast: argument will always be positive because 'letter_id' is assigned with the OFFSET added.
    const lat_band_id = letter_id - LAT_BAND_ID_TO_MGRS_LETTER_ID_OFFSET;

    // To calculate the UTM northing of the provided MGRS row within the UTM zone and latitude band there are three relationships to
    //  consider,
    // 	A. The number of MGRS squares between the equator and the southern boundary of the MGRS square through which
    // 	    the southern boundary of the UTM latitude band passes. This value is "nearest_northing_index". See related definition of
    //      "latitude band crossing" below.
    // 	B. The number of MGRS squares between the southern edge of the provided MGRS row ("square.row") and the southern edge of the
    //      "datum square" to the south of "square.row". This value is "point_ind".
    // 	C. The relative location of "datum square" with respect to the "latitude band crossing".
    // Quantities A. and B. can be relatively easy derived however C. is a little more involved as A. and B. are derived independently.

    // The following definitions are used in the comments below,
    //  - "datum square": the closest MGRS square to the south of "square.row" with an MGRS row value of 'A'
    //      (in the case of odd latitude bands) or 'F' (in the case of even latitude bands).
    //  - "latitude band crossing": the MGRS square row through which square.lat_band crosses.
    //  - "lat band crossing datum": the closest MGRS square row to the south of the "latitude band crossing" square with an MGRS row
    //     value of 'A' (in the case of odd latitude bands) or 'F' (in the case of even latitude bands).
    // When calculating the number of squares from/to these squares, the reference point on these is always the southern edge of the
    // specified squares.

    // Safe Cast: 'square.row' will always be at least 'A' because it is assigned from 'MGRS_LETTER'
    // 'row_id': The number of MGRS squares between the southern edge of the provide square.row and closest 'A' square to the South
    //      regardless of an even or odd latitude band at this point. This is corrected later.
    const row_id = MGRS_LETTER_ID[square.row - 'A'.charCodeAt(0)];
    // The row letter wraps around every 2000km (20 letters).
    // The latitude band resolves this.
    // latitude band number [0 to 20], 0 is the southern C zone.

    // 'nearest_northing_index': The (whole) number of MGRS squares between the equator and the southern edge of
    //      the MGRS square through which the southern edge of the UTM lat band (square.lat_band) crosses.
    // 'nearest_northing_index' is positive if square.lat_band is within Northern hemisphere and negative
    // if square.lat_band is within the Southern hemisphere. However, the use of modulo in the relationships below means the
    // North / South geometry and relationships is consistent for both the Northern and Southern hemisphere.
    const nearest_northing_index = Math.floor(BAND_NORTHING[lat_band_id] / M_PER_MGRS_SQUARE);

    // "lat_crossing_ind" is the number of squares between the "latitude band crossing" and "lat band crossing datum" to the South.
    // Northern hemisphere e.g. nearest_northing_index = 25, lat_crossing_ind = 5 i.e. "latitude band crossing"
    // is 5 squares North of the "lat band crossing datum" to the South.
    // Southern hemisphere e.g. nearest_northing_index = -25 (25 squares from equator South to southern edge of "latitude band crossing"),
    // lat_crossing_ind = 15 i.e. "latitude band crossing" is 15 squares North of the "lat band crossing datum" square to the South.
    const lat_crossing_ind = this.modulo(nearest_northing_index, NUMBER_MGRS_ROW_LETTERS);

    // "lat_crossing_offset_ind" is the number of squares between the "latitude band crossing" + offset and the
    // "lat band crossing datum" to the South. offset into the UTM zone (north) when finding if the closest "square.row" is to the
    // North or South. Offset of +5 is chosen as UTM lat bands that aren't C or X (South or North extents)
    // span 8 deg latitude ~9 MGRS squares. +5 moves up into roughly the centre of the UTM band.
    // C & X span 12 deg latitude ~13 MGRS squares.
    const offset = 5;
    const lat_crossing_offset_ind = this.modulo(nearest_northing_index + offset, NUMBER_MGRS_ROW_LETTERS);

    // "point_ind" is the number of squares between square.row and the "datum square" to the South.
    // Because row_id is the number of squares between square.row and the 'A' to the South (regardless of odd/even latitude band),
    // we must apply a correction (- row_start) for even latitude bands in order to get the number of squares to the 'datum_square'.
    const point_ind = this.modulo(row_id - row_start, NUMBER_MGRS_ROW_LETTERS);

    // The relationship between "point_ind" and "nearest_northing_index" is not known at this point.

    // There are four scenarios,
    // 	1. "datum square" is South of "latitude band crossing" and "square.row" is North of "latitude band crossing".
    //  "lat band crossing datum" and "datum square" are the same squares (Fig 1.)
    // Fig 1.
    //                               +-------+
    //                               |       |
    //                               |  C    | square.row = 'C'
    //                               |       |
    //              -----------------+-------+
    //               / \     --------------------------latitude band southern edge
    //                |              |  B    |
    //                |              |       |
    //  point_ind     |              +-------+------- latitude band crossing --------
    //                |              |       |                  / \             / \.
    //                | datum square |  A    |lat band crossing  |               | lat_crossing_ind
    //               \ /             |       |datum              |              \ /
    //              -----------------+-------+-                  |             -----
    //                               |       |                   |
    //                               |  V    |                   |
    //                               |       |                   |
    //                               +-------+                   |
    //                                   +                       |
    //                                   +                       nearest_northing_index
    //                                   +                       |
    //                                   +                       |
    //                               +-------+                   |
    //                               |       |                   |
    //                               |  B    |                   |
    //                               |       |                   |
    //                               +-------+                   |
    //                               |       |                   |
    //                               |  A    |                   |
    //                               |       |                  \ /
    //             ------------------+-------+-------------- Equator

    // 	2. "datum square" is North of "latitude band crossing" and "square.row" is North of "latitude band crossing".
    //  "lat band crossing datum" is South of "datum square" (Fig 2.)
    // Fig 2.
    //                                +-------+
    //                                |       |
    //                                |  C    | square.row = 'C'
    //                                |       |
    //               -----------------+-------+
    //                / \             |       |
    //                 |              |  B    |
    //                 |              |       |
    //   point_ind     |              +-------+
    //                 |              |       |
    //                 | datum square |  A    |
    //                \ /             |       |
    //               -----------------+-------+-
    //                      -------------------------- latitude band southern edge
    //                                |   V   |
    //                                |       |
    //                                +-------------  latitude band crossing   -----------
    //                                    +                                        / \.
    //                                    +                                         |
    //                                +-------+                                     |
    //                                |       |                                     | lat_crossing_ind
    //                                |  A    |   lat band crossing datum           |
    //                                |       |                                    \ /
    //                                +-------+-------------------------------------------

    // 	3. Both "datum square" and "square.row" are South of "latitude band crossing" (i.e. square.row is beyond the bounds of the UTM
    //  latitude band but still supported). "lat band crossing datum" and "datum square" are the same squares (Fig 3.)
    // Fig 3.
    //                               +-------+
    //                               |       |
    //                               |  A    |
    //                               |       |
    //              -----------------+-------+
    //                       --------------------------latitude band southern edge
    //                               |  V    |
    //                               |       |
    //                               +-------+------- latitude band crossing --------
    //                               |       |                      / \.
    //                               |  U    |                       |
    //                               |       |                       |
    //                              -+-------+-                      |
    //                               |       |                       |
    //                               |  T    |  square.row = 'T'     |
    //                               |       |                       |
    //            -------------------+-------+                       |
    //            / \                    +                           |
    //             |                     +                    lat_crossing_ind
    //             |                     +                           |
    //       point_ind                   +                           |
    //             |                 +-------+                       |
    //             |                 |       | lat band crossing     |
    //             |    datum square |  A    | datum                 |
    //            \ /                |       |                      \ /
    //             ------------------+-------+--------------------------

    // 	4. Both "datum square" "square.row" are South of "latitude band crossing" (i.e. square.row is beyond the bounds of the UTM
    //    latitude band but still supported). "datum square" is South of "lat band crossing datum" (Fig 4.)
    // Fig 4.
    //                               +-------+
    //                               |       |
    //                               |  C    |
    //                               |       |
    //              -----------------+-------+
    //                       --------------------------latitude band southern edge
    //                               |  B    |
    //                               |       |
    //                               +-------+------- latitude band crossing --------
    //                               |       |                      / \.
    //                               |  A    |  lat band crossing    |   lat_crossing_ind
    //                               |       |    datum             \ /
    //                               +-------+--------------------------
    //                               |       |
    //                               |  V    |  square.row = 'V'
    //                               |       |
    //             ----------------- +-------+
    //            / \                    +
    //             |                     +
    //             |                     +
    //      point_ind                    +
    //             |                 +-------+
    //             |                 |       |
    //             |    datum square |  A    |
    //            \ /                |       |
    //             ------------------+-------+--------------------------

    // "lat_crossing_mid_to_point" is the number of squares moving North from "square.row" to "latitude band crossing" + "offset".
    // In the case where "square.row" sits North of "latitude band crossing" + "offset" we get a 'wrapped' distance.
    const lat_crossing_mid_to_point = this.modulo(
      lat_crossing_offset_ind - point_ind,
      NUMBER_MGRS_ROW_LETTERS
    );

    // The following is used to determine if "square.row" is North or South of latitude band crossing.
    // "point_ind" and "lat_crossing_ind" + "offset" lie on a continuous spectrum of MGRS square rows (A - V).
    // Consider the following scenario taken from Fig 2. above on this continuous spectrum,
    //                      |ABCDEFGHJKLMNPQRSTUV|
    //                      |  x z              y|
    //
    // "square.row", x = C(2)
    // "point_ind" = 2
    // "lat_band_crossing", y = V(19)
    // "lat_crossing_offset_ind", z = mod(lat_band_crossing + offset, 20) = mod(19 + 5, 20) = 4
    // "lat_crossing_mid_to_point" = mod(lat_crossing_offset_ind - point_ind, 20) = mod(4 - 2, 20) = 2
    // Increasing letter indicies on this spectrum is equivelent to moving North in MGRS row square in both Northern
    // and Southern hemispheres.
    //
    // "lat_crossing_mid_to_point" gives the number of squares moving North from "square.row" to "lat_crossing_offset_ind" = 2
    //  i.e. from 'x' to 'z' in the diagram above.
    //
    // (20 - lat_crossing_mid_to_point) gives the number of squares moving North from "lat_crossing_offset_ind"
    // to "square.row" (wrapping around the end of the spectrum) = 18 i.e. from 'z' to 'x' in the diagram above.
    //
    // Our intention here is to find the closest "square.row" to "lat_crossing_offset_ind" considering the "square.row" to the North and
    // South.
    // If the distance (number of squares) from "lat_crossing_offset_ind" to the 'square.row" to the South (lat_crossing_mid_to_point)
    // is less than the distance from "lat_crossing_offset_ind" to "square.row" to the North (20 - lat_crossing_mid_to_point),
    // the closest "square.row" to "lat_crossing_offset_ind" is to the South i.e. "square.row" is South of "lat_crossing_offset_ind".
    // Otherwise "square.row" is North of "lat_crossing_mid_to_point".
    //
    // The conditional block below performs this check. However, an additional check ("&& lat_crossing_mid_to_point > offset") is done.
    // This results in finding the "square.row" (North or South) that is closest to roughly the centre of the UTM latitude band
    // ("lat_crossing_offset_ind") whilst applying the necessarily logic depending on the North or South relationship of
    // "square.row" w.r.t "latitude band crossing" (not latitude band crossing + offset).
    // i.e. for "square.row" to be South of "latitude band crossing" the distance between
    // "lat_crossing_offset_ind" to "square.row" must be greater than the offset. Otherwise "square.row" is North of
    // "latitude band crossing".

    // In the conditional blocks below we determine the number of cycles (row_cycles) (through the MGRS row index range (A - V))
    // there are between the equator and the Southern edge of "datum square" to the south of the southern edge of "square.row".
    // We do this so we can just add "point_ind" to the result to get the number of squares from equator to "square.row".
    let row_cycles = 0;

    // Determine if "square.row" is North or South of "latitude band crossing".
    if (
      NUMBER_MGRS_ROW_LETTERS - lat_crossing_mid_to_point >
        lat_crossing_mid_to_point &&
      lat_crossing_mid_to_point > offset
    ) {
      // "square.row" is South of "latitude band crossing" (scenario is Fig 3. or Fig 4.).
      // Determine if "lat band crossing datum" and "datum square" are the same square.
      // 0 : No "datum square" between the southern edge of "latitude band crossing" and "square.row".
      //      This is the scenario in Fig 3. i.e. "lat band crossing datum" and "datum square" are the same square.
      //      Move to the "datum square" by flooring. Note: this will take us to the South of "latitude band crossing"
      //      in both the Northern (+ve nearest_northing_index) and Southern hemisphere (-ve nearest_northing_index).
      // -1: "datum square" between "latitude band crossing" and "square.row".
      //      This is the scenario in Fig 4. i.e. "lat band crossing datum" and "datum square" are different squares.
      //      Move to the "lat band crossing datum" by flooring and -1 cycle to move down to "datum square".
      //      -1 will move us further South in both Northern and Southern hemispheres.
      //      This is the scenario in Fig 4. i.e. "lat band crossing datum" and "datum square" are different squares.
      const offset_cycles_south = (lat_crossing_ind > point_ind) ? 0 : -1;

      row_cycles =
        Math.floor(nearest_northing_index / NUMBER_MGRS_ROW_LETTERS) +
        offset_cycles_south;
    } else {
      // "square.row" is North of "latitude band crossing" (scenario is Fig 1. or Fig 2.).
      if (lat_crossing_ind > point_ind)
      {
        // There is a "datum square" between "latitude band crossing" and "square.row".
        // This is the scenario in Fig 2 i.e. "lat band crossing datum" and "datum square" are different squares.
        // Move North to the "datum square" by rounding up.
        // @ts-ignore
        row_cycles = Math.ceil(nearest_northing_index / NUMBER_MGRS_ROW_LETTERS);
      } else {
        // There is no "datum square" between the southern edge of lat band crossing and "square.row".
        // This is the scenario in Fig 1 (ignoring the "equator" line for Southern Hemisphere)
        // i.e. "lat band crossing datum" and "datum square" are the same square.
        // Move South to the "datum square" by rounding down.
        // @ts-ignore
        row_cycles = Math.floor(nearest_northing_index / NUMBER_MGRS_ROW_LETTERS);
      }
    }

    const northing_index = point_ind + row_cycles * NUMBER_MGRS_ROW_LETTERS;

    // Apply offset for Southern hemisphere only
    const false_northing = square.lat_band < 'N' ? FALSE_NORTHING : 0;
    const northing_origin = northing_index * M_PER_MGRS_SQUARE + false_northing;

    return [easting_origin, northing_origin];
  }

  mgrs_square_origin_arr(EN) {
    return [
      Math.floor(EN[0] / 100000) * 100000,
      Math.floor(EN[1] / 100000) * 100000,
    ];
  }

  mgrs_square(EN, has_false_northing, utm_zone) {
    const square = {};
    square.utm_zone = utm_zone;
    square.lat_band = this.northing_to_lat_band(EN[1], has_false_northing);

    // 100km square identifier.
    // note: latitude bands don't form any kind of origin for the next
    // splitting down to 100km squares.
    // Each 100km square has corners at precisely 100km multiples in UTM coordinates.
    //
    // column letter A-Z (omitting I,O), row letter A-V (~I,O).
    // column: UTM zone 1: A-H
    //             zone 2: J-R (~O)
    //             zone 3: S-Z
    //             zone 4: A-H
    //             ...
    // row: 1 (north of equator): A odd zones, F even zones.
    // just south of equator is V.
    //
    // We'll use a number to start with for column/row, e.g. 0-8.
    // Origin is bottom-left (southwest) corner of square.
    // Also, for any precision loss, truncate, don't round.

    // starting letter of column, for this UTM zone.
    // zone 1 = A, zone 2 = J, zone 3 = S.
    const column_start = ((utm_zone - 1) % 3) * 8;
    // Get the index (100km multiple) that this UTM easting falls into.
    // Note: the starting letter (e.g. A) actually starts (has a western
    // edge) at 100000m, so the index needs a -1.
    // UTM coords don't actually reach to below 100km easting.
    // @ts-ignore
    const easting_index = Math.floor(EN[0] / 100000) - 1;
    const column_id = column_start + easting_index;
    if (column_id > 23) {
      throw new Error('Column id out of range');
    }

    square.column = MGRS_LETTER[column_id];

    // even zones start at F
    const row_start = (utm_zone % 2 == 0) ? 5 : 0;
    const false_northing = has_false_northing ? FALSE_NORTHING : 0;
    const northing = EN[1] - false_northing;
    // @ts-ignore
    const northing_index = Math.floor(northing / 100000);
    const row_id_full = northing_index + row_start;
    // Index A-V (20), wraps around, increasing in the north direction.
    // Just south of the equator is V.
    // Use euclidean modulo.
    // @ts-ignore
    const row_id = row_id_full - Math.floor(row_id_full / 20.0) * 20;
    if (row_id > 23 || row_id < 0) {
      throw new Error('Row id out of range');
    }

    square.row = MGRS_LETTER[row_id];

    return square;
  }

  utm_to_mgrs(EN, has_false_northing, utm_zone) {
    const ret = {};
    ret.square = this.mgrs_square(EN, has_false_northing, utm_zone);
    const square_utm_origin = this.mgrs_square_origin(EN);
    ret.EN[0] = EN[0] - square_utm_origin[0];
    ret.EN[1] = EN[1] - square_utm_origin[1];
    return ret;
  }

  utm_to_mgrs_square(EN, square) {
    const ret = {};
    const square_utm_origin = this.mgrs_square_origin(square);
    ret.square = square;
    ret.EN[0] = EN[0] - square_utm_origin[0];
    ret.EN[1] = EN[1] - square_utm_origin[1];
    return ret;
  }

  mgrs_to_utm(mgrs_coords, square) {
    const square_utm_origin = this.mgrs_square_origin(square);
    return [
      mgrs_coords[0] + square_utm_origin[0],
      mgrs_coords[1] + square_utm_origin[1],
    ];
  }

  // // MGRS square (grid zone + 100km square id)
  // public struct Square
  // {
  //   public byte utm_zone;
  //   public char lat_band;
  //   public char column;
  //   public char row;
  // }
  //
  // // MGRS coordinates
  // public class Coord
  // {
  //   public Square square;
  //
  //   // easting-northing (m), relative to southwest corner of square.
  //   public double[] EN = new double [2];
  // }

  validate(square)
  {
    if (square.utm_zone > 60)
      throw new Error('MGRS Square Invalid: Invalid UTM zone.');

    if (
      !(
        square.lat_band === square.lat_band.toUpperCase()
          && square.column === square.column.toUpperCase()
          && square.row === square.row.toUpperCase())) {
      throw new Error("MGRS Square Invalid: Lowercase not permitted.");
    }
  }

}

// Constants in the Karney-Krueger equations for performing the ellipsoidal
// transverse Mercator projection. Refer to this paper:
// @misc{deakin2014transverse,
//   title={Transverse Mercator projection Karney-Krueger equations},
//   author={Deakin, RE},
//   year={2014}
// }
class KarneyKruegerConstants
{
  alpha = [];

  A = 0;

  // Note: requires c++14 for constexpr
  constructor() {
    const n = f / (2 - f);
    const n2 = n * n;
    const n3 = n2 * n;
    const n4 = n2 * n2;
    const n5 = n4 * n;
    const n6 = n4 * n2;
    const n7 = n6 * n;
    const n8 = n4 * n4;

    // rectifying radius A
    this.A = a / (1.0 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256 + n8 * 25.0 / 16384);

    // coefficients (via horner form)
    this.alpha[0] = (n
        (n *
          (n *
            (n *
              (n * (n * ((37884525 - 75900428 * n) * n + 42422016) - 89611200) +
                46287360) +
              63504000) -
            135475200) +
          +101606400
      / 203212800;
    this.alpha[1] = (n2 * (n * (n * (n * (n * (n * (148003883 * n + 83274912) - 178508970) + 77690880) + 67374720) -
        104509440) + 47174400))
      / 174182400;
    this.alpha[2] = (n3 * (n * (n * (n * (n * (318729724 * n - 738126169) + 294981280) + 178924680) - 234938880) +
      81164160)) / 319334400;
    this.alpha[3] = (n4 * (n * (n * ((14967552000 - 40176129013 * n) * n + 6971354016) - 8165836800) + 2355138720)) /
      7664025600;
    this.alpha[4] = (n5 * (n * (n * (10421654396 * n + 3997835751) - 4266773472) + 1072709352)) / 2490808320;
    this.alpha[5] = (n6 * (n * (175214326799 * n - 171950693600) + 38652967262)) / 58118860800;
    this.alpha[6] = (13700311101 - 67039739596 * n) * n7 / 12454041600;
  }
}
