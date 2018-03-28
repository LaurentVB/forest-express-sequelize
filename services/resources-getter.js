'use strict';
var _ = require('lodash');
var P = require('bluebird');
var Operators = require('../utils/operators');
var OperatorValueParser = require('./operator-value-parser');
var Interface = require('forest-express');
var CompositeKeysManager = require('./composite-keys-manager');
var QueryBuilder = require('./query-builder');
var SearchBuilder = require('./search-builder');
var LiveQueryChecker = require('./live-query-checker');
var ErrorHTTP422 = require('./errors').ErrorHTTP422;

function ResourcesGetter(model, opts, params) {
  var schema = Interface.Schemas.schemas[model.name];
  var queryBuilder = new QueryBuilder(model, opts, params);
  var segmentScope;
  var segmentWhere;
  var OPERATORS = new Operators(opts);

  var fieldNamesRequested = (function() {
    if (!params.fields || !params.fields[model.name]) { return null; }

    // NOTICE: Populate the necessary associations for filters
    var associationsForQuery = [];
    _.each(params.filter, function (values, key) {
      if (key.indexOf(':') !== -1) {
        var association = key.split(':')[0];
        associationsForQuery.push(association);
      }
    });

    if (params.sort && params.sort.indexOf('.') !== -1) {
      associationsForQuery.push(params.sort.split('.')[0]);
    }

    // NOTICE: Force the primaryKey retrieval to store the records properly in
    //         the client.
    var primaryKeyArray = [_.keys(model.primaryKeys)[0]];

    return _.union(primaryKeyArray, params.fields[model.name].split(','),
      associationsForQuery);
  })();

  function handleFilterParams() {
    var where = {};
    var conditions = [];

    _.each(params.filter, function (values, key) {
      if (key.indexOf(':') !== -1) {
        key = '$' + key.replace(':', '.') + '$';
      }
      values.split(',').forEach(function (value) {
        var condition = {};
        condition[key] = new OperatorValueParser(opts)
          .perform(model, key, value, params.timezone);
        conditions.push(condition);
      });
    });

    if (params.filterType) {
      where[OPERATORS[params.filterType.toUpperCase()]] = conditions;
    }

    return where;
  }

  function getWhere() {
    return new P(function (resolve, reject) {
      var where = {};
      where[OPERATORS.AND] = [];

      if (params.search) {
        where[OPERATORS.AND].push(new SearchBuilder(model, opts, params,
            fieldNamesRequested).perform());
      }

      if (params.filter) {
        where[OPERATORS.AND].push(handleFilterParams());
      }

      if (segmentWhere) {
        where[OPERATORS.AND].push(segmentWhere);
      }

      if (params.query) {
        var rawQuery = params.query.trim();
        new LiveQueryChecker().perform(rawQuery);

        // WARNING: Choosing the first connection might generate issues if the model
        //          does not belongs to this database.
        opts.connections[0]
          .query(rawQuery, { type: opts.sequelize.QueryTypes.SELECT })
          .then(function (result) {
            result = result.map(function (r) { return r.id; } );
            where[OPERATORS.AND].push({ id: { in: result } } );

            return resolve(where);
          }, function (error) {
            reject(error);
          });
      } else {
        return resolve(where);
      }
    });
  }

  function getAndCountRecords() {
    return getWhere()
      .then(function (where) {
        var countOpts = {
          include: queryBuilder.getIncludes(model, fieldNamesRequested),
          where: where
        };

        var findAllOpts = {
          where: where,
          include: queryBuilder.getIncludes(model, fieldNamesRequested),
          order: queryBuilder.getOrder(),
          offset: queryBuilder.getSkip(),
          limit: queryBuilder.getLimit()
        };

        if (params.search) {
          _.each(schema.fields, function (field) {
            if (field.search) {
              try {
                field.search(countOpts, params.search);
                field.search(findAllOpts, params.search);
              } catch (error) {
                Interface.logger.error('Cannot search properly on Smart Field ' +
                  field.field, error);
              }
            }
          });
        }

        if (segmentScope) {
          return P.all([
            model.scope(segmentScope).count(countOpts),
            model.scope(segmentScope).findAll(findAllOpts)
          ]);
        } else {
          return P.all([
            model.unscoped().count(countOpts),
            model.unscoped().findAll(findAllOpts)
          ]);
        }
    })
    .catch(function (error) {
      throw new ErrorHTTP422(error.message);
    });
  }

  function getSegment() {
    if (schema.segments && params.segment) {
      var segment = _.find(schema.segments, function (segment) {
        return segment.name === params.segment;
      });

      segmentScope = segment.scope;
      segmentWhere = segment.where;
    }
  }

  function getSegmentCondition() {
    if (_.isFunction(segmentWhere)) {
      return segmentWhere(params)
        .then(function (where) {
          segmentWhere = where;
          return;
        });
    } else {
      return new P(function (resolve) { return resolve(); });
    }
  }

  this.perform = function () {
    getSegment();

    return getSegmentCondition()
      .then(getAndCountRecords)
      .spread(function (count, records) {
        if (schema.isCompositePrimary) {
          records.forEach(function (record) {
            record.forestCompositePrimary =
              new CompositeKeysManager(model, schema, record)
                .createCompositePrimary();
          });
        }
        return [count, records];
      });
  };
}

module.exports = ResourcesGetter;
