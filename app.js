
var req = require('request')

var $secure = {WATTS_ALERTS: '<REST read key>',
              INSERT_KEY: '<insights write key>',
              ACCOUNT_ID: '<rpm account id>'}

var GViolations = {RunStatus: 'start'}
var GSetIntervalID = -1
var GStartDate = GetCurrentDayDateUTC()
var GEndDate = new Date(Date.now())
var GEventTableTargetName = 'AlertViolationSummary'

//fire off the function to asynchronously walk the paginated API
GetViolations()

//while we are walking the API chain -> poll for the 'done' state
GSetIntervalID = setInterval(AreWeDoneYet, 200)


/////////////////////////
// Functions
/////////////////////////
function AreWeDoneYet(){
  console.log('AreWeDoneYet(?)')
  if(GViolations.RunStatus != 'start'){
    if(GViolations.RunStatus == 'done'){
      console.log('AreWeDoneYet(yes) -> processing list')
      var oEntities = {}
      CreateEntities(oEntities)
      InsertEntities(oEntities)
    } else {
      console.log(`exiting with RunStatus[${GViolations.RunStatus}]`)
    }
    //stop polling and let Nodejs exit
    clearInterval(GSetIntervalID)
  } else {
    console.log('AreWeDoneYet(no)')
  }
}

//
// primary function to call NR Violation API
// must detect pagination header ("link")
// and queue next call in order to walk the pages
//
function GetViolations (nPage=1){
  console.log(`[${new Date()}] GetViolations(${GStartDate.toISOString()},PAGE=${nPage})`)

  var headers = {
  'Content-Type': 'json/application',
  'X-Api-Key': $secure.WATTS_ALERTS
  }

  var options = {
    url: 'https://api.newrelic.com/v2/alerts_violations.json',
    qs: {start_date: GStartDate.toISOString(), end_date: GEndDate.toISOString(), page: nPage},
    headers: headers
  }


  req.get(options, function (error,response,body){
      if (!error && response.statusCode == 200) {
        console.log(`[${new Date()}] GetViolations() - URI: ${options.url}`);
        var info = JSON.parse(body)

        //extreme debug
        //console.debug('Body -> ' + body)

        if(typeof GViolations.violations === 'undefined')
          GViolations.violations = info.violations
        else
          GViolations.violations = GViolations.violations.concat(info.violations)

        //check if api returned pagination headers
        if(response.headers.link != null){
          //extreme debug
          console.debug('pagination headers -> ' + response.headers.link)

          if (response.headers.link.toLowerCase().includes('rel="next"')) {
            console.log("There is more.")
            //queue next api call
            return GetViolations (nPage+1)
          }
        }

        //no pagination header detected so mark the api retrieval part as complete
        GViolations.RunStatus = 'done'
        return response
      } else {
        //rats - API call bombed out
        console.log(`GetViolations() error[${error}] status[${response.statusCode}]`)
        GViolations.RunStatus = 'error'
        return response
      }
  })
}

//
// function to calculate the time-window start date_end
// currently using 00:00:00 UTC of current day
//
function GetCurrentDayDateUTC(){
  var today = new Date()
  var dd = today.getUTCDate()
  var mm = today.getUTCMonth()
  var yyyy = today.getUTCFullYear()
  return new Date(Date.UTC(yyyy,mm,dd))
}

function CreateEntities(oEntities){
  var oEntity
  console.log('CreateEntities()-> Vio count:' + GViolations.violations.length)
  for (oVio of GViolations.violations) {
    //extreme debug
    //console.debug(JSON.stringify(oVio))

    //
    // Need to build an aggregationID upon which to aggregate similar violations
    // quirky thing with violations on metrics like apm-jvm-memory is that the entityid
    // is ephemeral based on the jvm instance that likely is bounced during the display
    // for entity.type == 'Application', the group_id is the apmApplicationId and for apm-jvm-memory
    // the entity.id is the jvm instance.  However entity.name is more consistent as it is
    // based on host+port as the identity of the jvm instance
    //
    if(oVio.entity.id != 0){
      if(oVio.entity.type == 'Application' && oVio.entity.name.length > 0 && oVio.entity.group_id != oVio.entity.id) {
        sAggregationID = 'EN-' + oVio.links.condition_id.toString() + '-' + oVio.entity.product + '-' + oVio.entity.type + '-' + oVio.entity.name.split(' ').join('_')
      } else {
        sAggregationID = 'EI-' + oVio.links.condition_id.toString() + '-' + oVio.entity.product + '-' + oVio.entity.type + '-' + oVio.entity.id.toString()
      }
    } else if (oVio.entity.group_id != 0) {
      sAggregationID = 'GI-' + oVio.links.condition_id.toString() + '-' + oVio.entity.product  + '-' + oVio.entity.type + '-' + oVio.entity.group_id.toString()
    } else {
      sAggregationID = 'CI-' + oVio.links.condition_id.toString() + '-' + oVio.entity.product  + '-' + oVio.entity.type
    }

    //
    // here we are using the fields of an object as the hash table key
    // "oEntities" is our hash table
    //
    oEntity = oEntities[sAggregationID]
    if(oEntity == null){
      oEntity = {}
      oEntity.ExampleViolationId = oVio.id.toString()         //IDs display better in Insights as strings
      oEntity.entityId = oVio.entity.id.toString()            //IDs display better in Insights as strings
      oEntity.entityGroupId = (typeof oVio.links.group_id == 'number') ? oVio.links.group_id.toString() : '?' //IDs display better in Insights as strings
      oEntity.entityName = oVio.entity.name
      oEntity.entityProduct = oVio.entity.product
      oEntity.entityType = oVio.entity.type
      oEntity.linkConditionId = (typeof oVio.links.condition_id == 'number') ? oVio.links.condition_id.toString() : '?'
      oEntity.linkPolicyId = (typeof oVio.links.policy_id == 'number') ? oVio.links.policy_id.toString() : '?'
      oEntity.ExampleIncidentId = (typeof oVio.links.incident_id == 'number') ? oVio.links.incident_id.toString() : '?'
      oEntity.Examplelabel = oVio.label
      oEntity.policyName = oVio.policy_name
      oEntity.conditionName = oVio.condition_name
      oEntity.eventType = GEventTableTargetName      //set the Insights Target Table Name
      oEntity.status_open = 0
      oEntity.status_closed = 0
      oEntity.priority_critical = 0
      oEntity.priority_warning = 0
      oEntity.total_violations = 0
      oEntity.aggregationID = sAggregationID
      oEntity.date_start = GStartDate.getTime()/1000  //start time window for violation rollup
      oEntity.date_end = GEndDate.getTime()/1000      //end time window for violation rollup
      oEntities[sAggregationID] = oEntity             //store this object in hash table
    }
    if(oVio.closed_at == null)
      oEntity.status_open += 1          //count up open tickets
    else
      oEntity.status_closed += 1        //count up closed tickets
    if(oVio.priority == 'Critical')
      oEntity.priority_critical += 1    //count up tickets marked as Critical
    else
      oEntity.priority_warning += 1     //count up tickets marked as warning
    oEntity.total_violations += 1       //let's keep a total count of tickets
  }
}

function InsertEntities(oEntities){
  //for (nID in oEntities){
  //  console.log('\n' + JSON.stringify(oEntities[nID]) + '\n')
  //}
  var aKeys = Object.keys(oEntities)
  if (aKeys.length == 0){
    console.log(`InsertEntities() -> oEntities is blank, exiting with no work`)
    return
  }

  var headers = {
    'Content-Type': 'json/application',
    'X-Insert-Key': $secure.INSERT_KEY
  };
  var options = {
    url: 'https://insights-collector.newrelic.com/v1/accounts/' + $secure.ACCOUNT_ID + '/events',
    headers: headers
  }

  // convert fields from the hash table object into an array of objects
  var result = aKeys.map(function(key) {return oEntities[key]})

  //stringify the array into the payload body
  options.body = JSON.stringify(result)

  console.debug("InsertEntities()-> going out: " + result.length.toString())

  //send to the mothership in the cloud
  req.post(options,function (error,response,body){
      if (!error && response.statusCode == 200)
        console.log('InsertEntities()-> Post success')
      else
        console.log(`InsertEntities()-> Post failed error[${error}] status[${response.statusCode}]`)
  })
}
