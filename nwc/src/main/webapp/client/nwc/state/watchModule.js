/*global angular,CONFIG*/
(function () {
    var watchModule = angular.module('nwc.watch', [
        'nwc.util',
        'nwc.conversion',
        'nwc.wps',
        'nwc.rdbParser',
        'nwc.sharedStateServices',
        'nwc.sosSources',
        'nwc.dataSeriesStore',
        'nwc.sosResponseParser',
        'nwc.streamStats',
        'nwc.map.waterBudget',
        'nwc.map.streamflow',
        'nwc.map.aquaticBiology']);

    //using a map as a set (need fast membership checking later)
    var watchServiceNames = Object.extended();
    
    watchModule.service('RunningWatches', [ '$log',
        function ($log) {
            //a psuedo-set of running watches
            //the keys are the watch names
            //the values are meaningless
            var runningWatches = {};
            var defaultValue = 1;

            return {
                /*
                 * @param {String} watchName
                 */
                add: function (watchName) {
                    $log.info('Started Running Watch "' + watchName + '"');
                    runningWatches[watchName] = defaultValue;
                },
                /**
                 * @param {type} watchName
                 */
                remove: function (watchName) {
                    $log.info('Stopped Running Watch "' + watchName + '"');
                    delete runningWatches[watchName];
                },
                /**
                 * @returns {Boolean} true if no running watches, false if running watches present
                 */
                isEmpty: function () {
                    return !Object.keys(runningWatches).length;
                }
            };
        }
    ]);
    
//call this function with the same arguments that you would module.factory()
    //@todo : eliminate this? It will confuse newcomers. The extra functionality this wrapper provides is likely unnecessary
    var registerWatchFactory = function (watchServiceName, dependencyArray) {
        var finalName = 'nwc.watch.' + watchServiceName;
        if (watchServiceName.has(finalName)) {
            throw Error("Duplicate watch service name. You must register unique watch service names.");
        }
        else {
            watchServiceNames[finalName] = 1;
            watchModule.factory(finalName, dependencyArray);
        }
    };
    var hucFeatureName = 'waterBudgetHucFeature';
    registerWatchFactory(hucFeatureName,
            ['$http', 'CommonState', 'SosSources', 'SosUrlBuilder', 'DataSeriesStore', 'SosResponseFormatter', '$q', '$log', 'DataSeries', 'WaterBudgetMap', 'RunningWatches',
                function ($http, CommonState, SosSources, SosUrlBuilder, DataSeriesStore, SosResponseFormatter, $q, $log, DataSeries, WaterBudgetMap, RunningWatches) {
                    /**
                     * @param {String} huc 12 digit identifier for the hydrologic unit
                     */
                    var getTimeSeries = function(huc){
                        var labeledAjaxCalls = [];
                            //grab the sos sources that will be used to display the initial data 
                            //series. ignore other data sources that the user can add later.
                            var initialSosSourceKeys = ['eta', 'dayMet'];
                            var initialSosSources = Object.select(SosSources, initialSosSourceKeys);
                            angular.forEach(initialSosSources, function (source, sourceId) {
                                var url = SosUrlBuilder.buildSosUrlFromSource(huc, source);
                                var labeledAjaxCall = $http.get(url, {label: sourceId});
                                labeledAjaxCalls.push(labeledAjaxCall);
                            });

                            var sosError = function () {
                                //@todo - modal window this
                                var errorMessage = 'error retrieving time series data';
                                alert(errorMessage);
                                $log.error(errorMessage);
                                $log.error(arguments);
                                RunningWatches.remove(hucFeatureName);
                            };
                            /**
                             * 
                             * @param {type} allAjaxResponseArgs all of the arguments normally passed to the individual callbacks of ajax calls
                             * @returns {undefined}
                             */
                            var sosSuccess = function (allAjaxResponseArgs) {
                                var self = this,
                                        errorsFound = false,
                                        labeledResponses = {};
                                $.each(allAjaxResponseArgs, function (index, ajaxResponseArgs) {
                                    var response = ajaxResponseArgs.data;
                                    if (!response || !response.length) {
                                        errorsFound = true;
                                        return false;//exit iteration
                                    }
                                    else {
                                        //the jqXHR object is the 3rd arg of response
                                        //the object has been augmented with a label property
                                        //by makeLabeledAjaxCall
                                        var label = ajaxResponseArgs.config.label;
                                        var parsedValues = SosResponseFormatter.formatSosResponse(response);
                                        
                                        var labeledDataSeries = DataSeries.new();
                                        labeledDataSeries.metadata.seriesLabels.push(
                                            {
                                                seriesName: SosSources[label].propertyLongName,
                                                seriesUnits: SosSources[label].units
                                            }
                                        );
                                        labeledDataSeries.metadata.downloadHeader = SosSources[label].downloadMetadata;
                                        labeledDataSeries.data = parsedValues;
                                        
                                        labeledResponses[label] = labeledDataSeries;
                                        CommonState[label] = labeledDataSeries;
                                    }
                                });
                                if (errorsFound) {
                                    sosError.apply(self, allAjaxResponseArgs);
                                }
                                else {
                                    DataSeriesStore.updateHucSeries(labeledResponses);
                                    CommonState.DataSeriesStore.merge(DataSeriesStore);
                                    //boolean property is cheaper to watch than deep object comparison
                                    CommonState.newDataSeriesStore = true;
                                    RunningWatches.remove(hucFeatureName);
                                }
                            };
                            $q.all(labeledAjaxCalls).then(sosSuccess, sosError);
                    };  
                    
                    return {
                        propertyToWatch: hucFeatureName,
                        watchFunction: function (prop, oldHucFeature, newHucFeature) {
                            RunningWatches.add(hucFeatureName);
                            if (newHucFeature) {
                                //clear downstream state
                                CommonState.WaterUsageDataSeries = DataSeries.new();
                                getTimeSeries(newHucFeature.data.HUC_12);
                            }
                            return newHucFeature;
                        }
                    };
                }
            ]);
    var countyFeatureName = 'countyFeature';
    registerWatchFactory(countyFeatureName,
            [           '$http', 'CommonState', 'SosSources', 'SosUrlBuilder', 'SosResponseParser', 'DataSeries', '$state', '$log', 'RunningWatches', 'HucCountiesIntersector', 'StoredState',
                function ($http, CommonState, SosSources, SosUrlBuilder, SosResponseParser, DataSeries, $state, $log, RunningWatches, HucCountiesIntersector, StoredState) {
                    return {
                        propertyToWatch: countyFeatureName,
                        watchFunction: function (prop, oldCountyFeature, newCountyFeature) {
                            RunningWatches.add(countyFeatureName);
                            var hucFeature = StoredState.waterBudgetHucFeature;
                            
                            CommonState.hucCountyIntersectionInfo = HucCountiesIntersector.intersectCounty(hucFeature, newCountyFeature);
                            
                            var offeringId = newCountyFeature.attributes.FIPS;
                            var countyArea = newCountyFeature.attributes.AREA_SQMI;
                            
                            var sosUrl = SosUrlBuilder.buildSosUrlFromSource(offeringId, SosSources.countyWaterUse);

                            var waterUseFailure = function (response) {
                                var url = response.config.url;
                                var message = 'An error occurred while retrieving water use data from:\n' +
                                        url + '\n' +
                                        'See browser logs for details';
                                alert(message);
                                $log.error('Error while accessing: ' + url + '\n' + response.data);
                                RunningWatches.remove(countyFeatureName);
                            };

                            var waterUseSuccess = function (response) {
                                var data = response.data;
                                if (!data || data.has('exception') || data.has('error')) {
                                    waterUseFailure(response);
                                } else {
                                    var parsedTable = SosResponseParser.parseSosResponse(data);
                                    
                                    var waterUseDataSeries = DataSeries.new();
                                    waterUseDataSeries.data = parsedTable;

                                    //use the series metadata as labels
                                    var additionalSeriesLabels = SosSources.countyWaterUse.propertyLongName.split(',');
                                    additionalSeriesLabels.each(function(label) {
                                        waterUseDataSeries.metadata.seriesLabels.push({
                                            seriesName: label,
                                            seriesUnits: SosSources.countyWaterUse.units
                                        });
                                    });
                                    waterUseDataSeries.metadata.downloadHeader = SosSources.countyWaterUse.downloadMetadata;

                                    CommonState.WaterUsageDataSeries = waterUseDataSeries;
                                    CommonState.newWaterUseData = true;
                                    RunningWatches.remove(countyFeatureName);
                                    $state.go('workflow.waterBudget.plotData');
                                }
                            };

                            $http.get(sosUrl).then(waterUseSuccess, waterUseFailure);

                            return newCountyFeature;
                        }
                    };
                }
            ]);
    var nwisBaseUrl = CONFIG.endpoint.nwis;
    var getNwisQueryParams = function () {
        return {
            'format': 'rdb',
            'seriesCatalogOutput': 'true',
            'parameterCd': '00060',
            'outputDataTypeCd': 'dv'
        };
    };
    var startDateColName = 'begin_date';
    var endDateColName = 'end_date';
    
    /**
     * Replace '-' with '/' in date strings to prevent time-zone errors.
     * @param {String} dateStr
     * @returns {String}
     */
    var reformatDateStr = function(dateStr){
      return dateStr.replace(/-/g, '/');
    };
    var strToDate = function(dateStr){
        return Date.create(dateStr).utc();
    };
    /**
     * On gage change, query nwis for the start and end dates of that gage's relevant data.
     * Once obtained, stuff start and end dates into Common State as absolute minimums and maximums for the datepickers
     * Then navigate to the stat params form.
     */
    var gageName = 'gage';
    registerWatchFactory(gageName, [
        '$http', 'CommonState', '$log', 'StreamStats', '$rootScope', 'StoredState', 'rdbParser', '$state', 'RunningWatches',
        function ($http, CommonState, $log, StreamStats, $rootScope, StoredState, rdbParser, $state, RunningWatches) {
            
            return {
                propertyToWatch: gageName,
                //once a gage is selected, ask nwis what the relevant period of record is
                watchFunction: function (prop, oldValue, newGage) {
                    RunningWatches.add(gageName);
                    if (newGage !== undefined) {
                        //reset params
                        CommonState.streamFlowStatMinDate = undefined;
                        CommonState.streamFlowStatMaxDate = undefined;

                        var siteId = newGage.data.STAID;
                        var params = getNwisQueryParams();
                        params.sites = siteId;
                        
                        var queryString = Object.toQueryString(params);
                        
                        var url = nwisBaseUrl + "?" + queryString;

                        var gageInfoFailure = function(response) {
                            var msg = 'An error occurred while asking NWIS web for the period of record for the selected site';
                            $log.error(msg);
                            alert(msg);
                            RunningWatches.remove(gageName);
                        };
                        var gageInfoSuccess = function (response) {
                            var rdbTables = rdbParser.parse(response.data);
                            if (!rdbTables.length) {
                                throw Error('Error parsing NWIS series catalog output response');
                            }
                            var table = rdbTables[0];
                            var startColumn = table.getColumnByName(startDateColName);
                            startColumn = startColumn.map(reformatDateStr);
                            startColumn = startColumn.map(strToDate);
                            startColumn.sort(function(a, b) {
                                return a - b;
                            });
                            var startDate = startColumn[0];

                            var endColumn = table.getColumnByName(endDateColName);
                            endColumn = endColumn.map(reformatDateStr);
                            endColumn = endColumn.map(strToDate);
                            endColumn.sort(function(a, b) {
                                return b - a;
                            });
                            var endDate = endColumn[0];

                            CommonState.streamFlowStatMinDate = startDate;
                            CommonState.streamFlowStatMaxDate = endDate;
                            RunningWatches.remove(gageName);
                            // set this so that the Streamflow Data Plot button does not show
                            StoredState.streamFlowStatHucFeature = false;
                            // Adding this back here, need to rework some of this logic 
                            $state.go('workflow.streamflowStatistics.setSiteStatisticsParameters');
                        };
                        $http.get(url).then(gageInfoSuccess, gageInfoFailure);
                    } else {
                        RunningWatches.remove(gageName);
                    }
                    return newGage;
                }
            };
        }
    ]);
    var streamStatsReadyName = 'streamflowStatsParamsReady';
    registerWatchFactory(streamStatsReadyName,
                        ['$http', 'CommonState', '$log', 'StreamStats', '$rootScope', 'StoredState', 'RunningWatches', '$state',
                function ($http, CommonState, $log, StreamStats, $rootScope, StoredState, RunningWatches, $state) {
                    return {
                        propertyToWatch: 'streamflowStatsParamsReady',
                        watchFunction: function (prop, oldValue, streamFlowStatsParamsReady) {
                            RunningWatches.add(streamStatsReadyName);
                            // set this so that the Streamflow Data Plot graph does not display until button pushed
                            CommonState.showStreamflowPlot =  false;
                            if (streamFlowStatsParamsReady) {
                                //reset
                                CommonState.streamflowStatistics = [];

                                var newGage = StoredState.gage;
                                var newHuc = StoredState.streamFlowStatHucFeature;
                                var startDate = StoredState.siteStatisticsParameters.startDate;
                                var endDate = StoredState.siteStatisticsParameters.endDate;
                                var tsvHeader;
                                var callback = function(statistics, resultsUrl){
                                    CommonState.streamflowStatistics = statistics;
                                    CommonState.streamflowStatisticsUrl = resultsUrl;
                                    var tsvValues = "Name\tValue\tDescription\n";
                                    var i;
                                    for (i = 0; i < statistics.length; i += 1) {
                                    	if (statistics[i].name) {
                                        	tsvValues += statistics[i].name + "\t";
                                    	}
                                    	else {
                                    		tsvValues += "\t";
                                    	}
                                    	if (statistics[i].value) {
                                        	tsvValues += statistics[i].value + "\t";                                    		
                                    	}
                                    	else {
                                    		tsvValues += "\t";                                    		
                                    	}
                                    	if (statistics[i].desc) {
                                        	tsvValues += statistics[i].desc + "\n";                                    		
                                    	}
                                    	else {
                                    		tsvValues += "\n";                                    		
                                    	}
                                    }
                                    CommonState.streamFlowStatisticsTsv = encodeURIComponent(tsvHeader + tsvValues);
                                    RunningWatches.remove(streamStatsReadyName);
                                };
                                var statTypes  = StoredState.siteStatisticsParameters.statGroups;
                                
                                if(newGage){
                                    var siteId = newGage.data.STAID;
                                    tsvHeader = "\"# Data derived from the USGS NWIS Web Services.\"\n";
                                    tsvHeader += "\"# Statistics calculated using the USGS EflowStats package.\"\n";
                                    tsvHeader += "\"# http://waterdata.usgs.gov/nwis/nwisman/?site_no=" + siteId + " \"\n";
                                    tsvHeader += "\"# http://github.com/USGS-R/EflowStats \"\n";
                                    StreamStats.getSiteStats([siteId], statTypes, startDate, endDate, callback);
                                }
                                else if(newHuc){
                                    var hucId = newHuc.data.HUC12;
                                    tsvHeader = "\"# Data derived from National Water Census daily flow estimates.\"\n";
                                    tsvHeader += "\"# HUC " + hucId +  " was selected.\"\n";
                                    tsvHeader += "\"# Statistics calculated using the USGS EflowStats Package\"\n";
                                    tsvHeader += "\"# http://cida.usgs.gov/nwc/ang/#/workflow/streamflow-statistics/select-site \"\n";
                                    tsvHeader += "\"# http://github.com/USGS-R/EflowStats \"\n";
                                    StreamStats.getHucStats([hucId], statTypes, startDate, endDate, callback);
                                }
                                else{
                                    var msg = 'Error: Neither a HUC nor a gage is defined. Cannot continue computing statistics.';
                                    $log.error(StoredState.streamFlowStatHucFeature);
                                    alert(msg);
                                    RunningWatches.remove(streamStatsReadyName);
                                }
                            }
                            else {
                                RunningWatches.remove(streamStatsReadyName);
                            }
                            return streamFlowStatsParamsReady;
                        }
                    };
                }
            ]
    );
    
    var modeledQName = "readyForModeledQ";
    registerWatchFactory(modeledQName,
                        ['$http', '$log', '$rootScope', '$state', 'CommonState', 'StoredState', 'RunningWatches', 'SosUrlBuilder', 'SosSources', 'SosResponseFormatter', 'DataSeries',
                function ($http, $log, $rootScope, $state, CommonState, StoredState, RunningWatches, SosUrlBuilder, SosSources, SosResponseFormatter, DataSeries) {
                    return {
                        propertyToWatch: 'readyForModeledQ',
                        watchFunction: function (prop, oldValue, readyForModeledQ) {
                            RunningWatches.add(modeledQName);
                            
                            if (readyForModeledQ && StoredState.streamFlowStatHucFeature) {
                                var offeringId = StoredState.streamFlowStatHucFeature.data.site_no;

                                var sosUrl = SosUrlBuilder.buildSosUrlFromSource(offeringId, SosSources.modeledQ);

                                var modeledFailure = function (response) {
                                    var url = response.config.url;
                                    var message = 'An error occurred while retrieving water use data from:\n' +
                                            url + '\n' +
                                            'See browser logs for details';
                                    alert(message);
                                    $log.error('Error while accessing: ' + url + '\n' + response.data);
                                    RunningWatches.remove(modeledQName);
                                };

                                var modeledSuccess = function (response) {
                                    var data = response.data;
                                    if (!data || data.has('exception') || data.has('error')) {
                                        modeledFailure(response);
                                    } else {
                                        var parsedTable = SosResponseFormatter.formatSosResponse(data);
                                        var convertedTable = parsedTable.map(function(row) {
                                            return row.map(function(column, index){
                                                var val = column;
                                                if (index === 0) {
                                                    val = strToDate(column);
                                                }
                                                return val;
                                            });
                                        });

                                        var modeledDataSeries = DataSeries.new();
                                        modeledDataSeries.data = convertedTable;

                                        //use the series metadata as labels
                                        var additionalSeriesLabels = SosSources.modeledQ.propertyLongName.split(',');
                                        additionalSeriesLabels.each(function(label) {
                                            modeledDataSeries.metadata.seriesLabels.push({
                                                seriesName: label,
                                                seriesUnits: SosSources.modeledQ.units
                                            });
                                        });
                                        modeledDataSeries.metadata.downloadHeader = SosSources.modeledQ.downloadMetadata;

                                        CommonState.ModeledHucDataSeries = modeledDataSeries;
                                        CommonState.newModeledHucData = true;
                                        RunningWatches.remove(modeledQName);
                                    }
                                };

                                $http.get(sosUrl).then(modeledSuccess, modeledFailure);
                            } else {
                                RunningWatches.remove(modeledQName);
                            }
                            return readyForModeledQ;
                        }
                    };
                }
            ]
    );
    
    var allWatchServiceNames = watchServiceNames.keys();
    var dependencies = ['StoredState'].concat(allWatchServiceNames);

    var registerAllWatchers = function(StoredState){
        var watchServices = Array.create(arguments).from(1);//ignore storedState
        angular.forEach(watchServices, function(watchService){
            StoredState.watch(watchService.propertyToWatch, watchService.watchFunction);
        });
    };
    watchModule.run(dependencies.concat([registerAllWatchers]));

}());