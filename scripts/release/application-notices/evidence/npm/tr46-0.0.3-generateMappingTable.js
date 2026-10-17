"use strict";

var fs = require("fs");
var request = require("request");

request.get("http://www.unicode.org/Public/idna/latest/IdnaMappingTable.txt", function(err, res, body) {
  if (err) {
    throw err;
  }
  
  var lines = [];
  
  body.split("\n").forEach(function(l) {
    l = l.split("#")[0]; // remove comments
    var cells = l.split(";").map(function(c) {
      return c.trim();
    });
    if (cells.length === 1) return;
    
    // parse ranges to int[2] array
    var range = cells[0].split("..");
    var start = parseInt(range[0], 16);
    var end = parseInt(range[1] || range[0], 16);
    cells[0] = [start, end];
    
    if (cells[2] !== undefined) {
      // parse replacement to int[] array
      var replacement = cells[2].split(" ");
      if (replacement[0] === "") { // empty array
        replacement = [];
      }
      
      replacement = replacement.map(function(r) {
        return parseInt(r, 16);
      });
      
      cells[2] = replacement;
    }
    
    lines.push(cells);
  });
  
  // we could drop valid chars, but those are only ~1000 ranges and
  // binary search is way to quick to even notice that
  
  fs.writeFile(__dirname + "/../lib/mappingTable.json", JSON.stringify(lines));
});
