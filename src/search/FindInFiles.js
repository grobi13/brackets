/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, $, PathUtils, window, document */

/*
 * Adds a "find in files" command to allow the user to find all occurances of a string in all files in
 * the project.
 * 
 * The keyboard shortcut is Cmd(Ctrl)-Shift-F.
 *
 * FUTURE:
 *  - Proper UI for both dialog and results
 *  - Refactor dialog class and share with Quick File Open
 *  - Search files in working set that are *not* in the project
 *  - Handle matches that span mulitple lines
 *  - Refactor UI from functionality to enable unit testing
 */


define(function (require, exports, module) {
    "use strict";
    
    var Async               = require("utils/Async"),
        CommandManager      = require("command/CommandManager"),
        Commands            = require("command/Commands"),
        Strings             = require("strings"),
        StringUtils         = require("utils/StringUtils"),
        DocumentManager     = require("document/DocumentManager"),
        EditorManager       = require("editor/EditorManager"),
        FileIndexManager    = require("project/FileIndexManager"),
        AppInit             = require("utils/AppInit"),
        PreferencesManager  = require("preferences/PreferencesManager");
    
    var FIND_IN_FILES_MAX = 100;

    var EDITOR_MIN_HEIGHT = 400,
        MIN_HEIGHT = 100;
    
    var PREFERENCES_CLIENT_ID = module.id,
        defaultPrefs = { height: 200 };
    
    // These vars are initialized by the htmlReady handler
    // below since they refer to DOM elements
    var $searchResults,
        $searchContent,
        $searchResizer;
    
    // This dialog class was mostly copied from QuickOpen. We should have a common dialog
    // class that everyone can use.
    
    /**
    * FindInFilesDialog class
    * @constructor
    *
    */
    function FindInFilesDialog() {
        this.closed = false;
        this.result = null; // $.Deferred
    }

    /**
    * Creates a dialog div floating on top of the current code mirror editor
    */
    FindInFilesDialog.prototype._createDialogDiv = function (template) {
        this.dialog = $("<div />")
                          .attr("class", "CodeMirror-dialog")
                          .html("<div>" + template + "</div>")
                          .prependTo($("#editor-holder"));
    };
    
    /**
    * Closes the search dialog and resolves the promise that showDialog returned
    */
    FindInFilesDialog.prototype._close = function (value) {
        if (this.closed) {
            return;
        }
        
        this.closed = true;
        this.dialog.remove();
        EditorManager.focusEditor();
        this.result.resolve(value);
    };
    
    /**
    * Shows the search dialog 
    * @param {?string} initialString Default text to prepopulate the search field with
    * @returns {$.Promise} that is resolved with the string to search for
    */
    FindInFilesDialog.prototype.showDialog = function (initialString) {
        var dialogHTML = Strings.CMD_FIND_IN_FILES +
            ": <input type='text' id='findInFilesInput' style='width: 10em'> <span style='color: #888'>(" +
            Strings.SEARCH_REGEXP_INFO  + ")</span>";
        this.result = new $.Deferred();
        this._createDialogDiv(dialogHTML);
        var $searchField = $("input#findInFilesInput");
        var that = this;
        
        $searchField.attr("value", initialString || "");
        $searchField.get(0).select();
        
        $searchField.bind("keydown", function (event) {
            if (event.keyCode === 13 || event.keyCode === 27) {  // Enter/Return key or Esc key
                event.stopPropagation();
                event.preventDefault();
                
                var query = $searchField.val();
                
                if (event.keyCode === 27) {
                    query = null;
                }
                
                that._close(query);
            }
        })
            .blur(function () {
                that._close(null);
            })
            .focus();
        
        return this.result.promise();
    };


    function _getSearchMatches(contents, queryExpr) {
        // Quick exit if not found
        if (contents.search(queryExpr) === -1) {
            return null;
        }
        
        var trimmedContents = contents;
        var startPos = 0;
        var matchStart;
        var matches = [];
        
        
        var match;
        var lines = StringUtils.getLines(contents);
        while ((match = queryExpr.exec(contents)) !== null) {
            var lineNum = StringUtils.offsetToLineNum(lines, match.index);
            var line = lines[lineNum];
            var ch = match.index - contents.lastIndexOf("\n", match.index) - 1;  // 0-based index
            var matchLength = match[0].length;
            
            // Don't store more than 200 chars per line
            line = line.substr(0, Math.min(200, line.length));
            
            matches.push({
                start: {line: lineNum, ch: ch},
                end: {line: lineNum, ch: ch + matchLength},
                line: line
            });
        }

        return matches;
    }
        
    function _showSearchResults(searchResults) {
        var $searchResultsDiv = $("#search-results");
        
        if (searchResults && searchResults.length) {
            var $resultTable = $("<table class='zebra-striped condensed-table' />")
                                .append("<tbody>");
            
            // Count the total number of matches
            var numMatches = 0;
            searchResults.forEach(function (item) {
                numMatches += item.matches.length;
            });
            
            // Show result summary in header
            var summary = StringUtils.format(
                Strings.FIND_IN_FILES_TITLE,
                numMatches,
                (numMatches > 1) ? Strings.FIND_IN_FILES_MATCHES : Strings.FIND_IN_FILES_MATCH,
                searchResults.length,
                (searchResults.length > 1 ? Strings.FIND_IN_FILES_FILES : Strings.FIND_IN_FILES_FILE)
            );
            
            $("#search-result-summary")
                .text(summary +
                     (numMatches > FIND_IN_FILES_MAX ? StringUtils.format(Strings.FIND_IN_FILES_MAX, FIND_IN_FILES_MAX) : ""))
                .prepend("&nbsp;");  // putting a normal space before the "-" is not enough
            
            var resultsDisplayed = 0;
            
            searchResults.forEach(function (item) {
                if (item && resultsDisplayed < FIND_IN_FILES_MAX) {
                    var makeCell = function (content) {
                        return $("<td/>").html(content);
                    };
                    
                    var esc = function (str) {
                        str = str.replace(/</g, "&lt;");
                        str = str.replace(/>/g, "&gt;");
                        return str;
                    };
                    
                    var highlightMatch = function (line, start, end) {
                        return esc(line.substr(0, start)) + "<span class='highlight'>" + esc(line.substring(start, end)) + "</span>" + esc(line.substr(end));
                    };
                    
                    // Add row for file name
                    $("<tr class='file-section' />")
                        .append("<td colspan='3'>" + StringUtils.format(Strings.FIND_IN_FILES_FILE_PATH, item.fullPath) + "</td>")
                        .click(function () {
                            // Clicking file section header collapses/expands result rows for that file
                            var $fileHeader = $(this);
                            $fileHeader.nextUntil(".file-section").toggle();
                        })
                        .appendTo($resultTable);
                    
                    // Add row for each match in file
                    item.matches.forEach(function (match) {
                        if (resultsDisplayed < FIND_IN_FILES_MAX) {
                            var $row = $("<tr/>")
                                .append(makeCell(" "))      // Indent
                                .append(makeCell(StringUtils.format(Strings.FIND_IN_FILES_LINE, (match.start.line + 1))))
                                .append(makeCell(highlightMatch(match.line, match.start.ch, match.end.ch)))
                                .appendTo($resultTable);
                            
                            $row.click(function () {
                                CommandManager.execute(Commands.FILE_OPEN, {fullPath: item.fullPath})
                                    .done(function (doc) {
                                        // Opened document is now the current main editor
                                        EditorManager.getCurrentFullEditor().setSelection(match.start, match.end);
                                    });
                            });
                            resultsDisplayed++;
                        }
                    });
                    
                }
            });
            
            $("#search-results .table-container")
                .empty()
                .append($resultTable);
            
            $("#search-results .close")
                .one("click", function () {
                    $searchResultsDiv.hide();
                    EditorManager.resizeEditor();
                });
            
            $searchResultsDiv.show();
        } else {
            $searchResultsDiv.hide();
        }
        
        EditorManager.resizeEditor();
    }
    
    function _getQueryRegExp(query) {
        // If query is a regular expression, use it directly
        var isRE = query.match(/^\/(.*)\/(g|i)*$/);
        if (isRE) {
            // Make sure the 'g' flag is set
            var flags = isRE[2] || "g";
            if (flags.search("g") === -1) {
                flags += "g";
            }
            return new RegExp(isRE[1], flags);
        }

        // Query is a string. Turn it into a case-insensitive regexp
        
        // Escape regex special chars
        query = query.replace(/([(){}\[\].\^$|?+*\\])/g, "\\$1");
        return new RegExp(query, "gi");
    }
    
    /**
    * Displays a non-modal embedded dialog above the code mirror editor that allows the user to do
    * a find operation across all files in the project.
    */
    function doFindInFiles() {

        var dialog = new FindInFilesDialog();
        var searchResults = [];
        
        // Default to searching for the current selection
        var currentEditor = EditorManager.getFocusedEditor();
        var initialString = currentEditor && currentEditor.getSelectedText();
                            
        dialog.showDialog(initialString)
            .done(function (query) {
                if (query) {
                    var queryExpr = _getQueryRegExp(query);
                    FileIndexManager.getFileInfoList("all")
                        .done(function (fileListResult) {
                            Async.doInParallel(fileListResult, function (fileInfo) {
                                var result = new $.Deferred();
                                
                                DocumentManager.getDocumentForPath(fileInfo.fullPath)
                                    .done(function (doc) {
                                        var matches = _getSearchMatches(doc.getText(), queryExpr);
                                        
                                        if (matches && matches.length) {
                                            searchResults.push({
                                                fullPath: fileInfo.fullPath,
                                                matches: matches
                                            });
                                        }
                                        result.resolve();
                                    })
                                    .fail(function (error) {
                                        // Error reading this file. This is most likely because the file isn't a text file.
                                        // Resolve here so we move on to the next file.
                                        result.resolve();
                                    });
                                
                                return result.promise();
                            })
                                .done(function () {
                                    _showSearchResults(searchResults);
                                })
                                .fail(function () {
                                    console.log("find in files failed.");
                                });
                        });
                }
            });
    }
    
    /**
     * @private
     * Sets sidebar width and resizes editor. Does not change internal sidebar open/closed state.
     * @param {number} width Optional width in pixels. If null or undefined, the default width is used.
     */
    function _setHeight(height) {
        // if we specify a width with the handler call, use that. Otherwise use
        // the greater of the current width or 200 (200 is the minimum width we'd snap back to)
        
        var prefs                   = PreferencesManager.getPreferenceStorage(PREFERENCES_CLIENT_ID, defaultPrefs);
        //    sidebarWidth            = Math.max(prefs.getValue("sidebarWidth"), 10);
        
        //width = width || Math.max($sidebar.width(), sidebarWidth);
        
        $searchResults.height(height);
        $searchContent.height(height - 30);
        //$jslintResizer.css("bottom", height - 1);
        
        // the following three lines help resize things when the sidebar shows
        // but ultimately these should go into ProjectManager.js with a "notify" 
        // event that we can just call from anywhere instead of hard-coding it.
        // waiting on a ProjectManager refactor to add that. 
        // $sidebar.find(".sidebar-selection").width(width);
        
        prefs.setValue("height", height);
        EditorManager.resizeEditor();
    }
    
    /**
     * @private
     * Install sidebar resize handling.
     */
    function _initSearchResizer() {
        var $mainView               = $(".main-view"),
            $body                   = $(document.body),
            prefs                   = PreferencesManager.getPreferenceStorage(PREFERENCES_CLIENT_ID, defaultPrefs),
            animationRequest        = null,
            isMouseDown             = false;
        
        $searchResizer.on("mousedown.search", function (e) {
            var startY = e.clientY,
                newHeight = Math.min($mainView.height() - e.clientY, $mainView.height() - EDITOR_MIN_HEIGHT),
                doResize = true;
            
            newHeight = Math.max(newHeight, MIN_HEIGHT);
            isMouseDown = true;

            // take away the shadows (for performance reasons during sidebarmovement)
            //$sidebar.find(".scroller-shadow").css("display", "none");
            
            $body.toggleClass("hor-resizing");
            
            animationRequest = window.webkitRequestAnimationFrame(function doRedraw() {
                // only run this if the mouse is down so we don't constantly loop even 
                // after we're done resizing.
                if (!isMouseDown) {
                    return;
                }
                
                if (doResize) {
                    // for right now, displayTriangle is always going to be false for _setWidth
                    // because we want to hide it when we move, and _setWidth only gets called
                    // on mousemove now.
                    _setHeight(newHeight);
                }
                
                animationRequest = window.webkitRequestAnimationFrame(doRedraw);
            });
            
            $mainView.on("mousemove.search", function (e) {
                newHeight = Math.min($mainView.height() - e.clientY, $mainView.height() - EDITOR_MIN_HEIGHT);
                newHeight = Math.max(newHeight, MIN_HEIGHT);
                e.preventDefault();
            });
                
            $mainView.one("mouseup.search", function (e) {
                isMouseDown = false;
                
                // replace shadows and triangle
                //$sidebar.find(".scroller-shadow").css("display", "block");
                
                //$projectFilesContainer.triggerHandler("scroll");
                //$openFilesContainer.triggerHandler("scroll");
                $mainView.off("mousemove.search");
                $body.toggleClass("hor-resizing");
                //startingSidebarPosition = $sidebar.width();
            });
            
            e.preventDefault();
        });
    }

    CommandManager.register(Strings.CMD_FIND_IN_FILES,  Commands.EDIT_FIND_IN_FILES,    doFindInFiles);
    
        // Initialize items dependent on HTML DOM
    AppInit.htmlReady(function () {
        $searchResults  = $("#search-results");
        $searchResizer  = $("#search-resizer");
        $searchContent  = $("#search-results .table-container");

        // init
        _initSearchResizer();
    });
});