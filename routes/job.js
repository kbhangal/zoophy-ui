'use strict';

let app = require('../app');
let express = require('express');
let checkInput = require('../bin/validator_tool').checkInput;
let logger = require('../bin/logger_tool');
let request = require('request');
let fs = require('fs');
let uuid = require('uuid/v4');
let path = require('path');
let multer = require('multer');
const multerOptions = {
  dest: 'uploads/',
  limits: {
    fileSize: 50000 //50KB
  }
};
let upload = multer(multerOptions);
let GLMPredictor = require('../bin/glm_predictor');

const API_URI = require('../bin/settings').API_CONFIG.ZOOPHY_URI;

const DOWNLOAD_FOLDER = path.join(__dirname, '../public/downloads/');
const ACCESSION_RE = /^([A-Z]|\d|_|\.){5,10}?$/;
const EMAIL_RE = /^[^@\s]+?@[^@\s]+?\.[^@\s]+?$/;
const JOB_NAME_RE = /^(\w| |-|_|#|&){3,255}?$/;
const BASE_ERROR = 'INVALID JOB PARAMETER(S): ';
const PREDICTOR_FILE_RE = /.{1,250}?\.tsv$/;
const STATE_RE = /^(\w|-|\.|\,| |\’|\'){1,255}?$/;
const PREDICTOR_RE = /^(\w|-|\.| ){1,255}?$/;
const SUB_MODEL_RE = /^(HKY)|(GTR)$/;
const CLOCK_MODEL_RE = /^(Strict)|(Relaxed)$/;
const PRIOR_RE = /^(Constant)|(Skyline)|(Skygrid)$/;

const FASTA_MET_UID_RE = /^(\w|\d){1,20}?$/;
const FASTA_MET_HUM_DATE_RE = /^(((0[1-9]|[12][0-9]|3[01])\-)?((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\-)?\d{4})$/;
const FASTA_MET_DEC_DATE_RE = /^\d{4}(\.\d{1,4})?$/;
const FASTA_MET_GEOID_RE = /^\d{4,10}$/;
const FASTA_MET_LOCNAME_RE = /^((([\w -']){1,30})|\d{4,10})?$/;
const FASTA_MET_SEQ_RE = /^([ACGTacgt-]){1,20000}$/;
const SOURCE_GENBANK = 1;
const SOURCE_FASTA = 2;

let router = express.Router();

router.post('/run', function(req, res) {
  let result;
  try {
    let jobErrors = BASE_ERROR;
    let records;
    if (!req.body.records) {
      jobErrors += 'Missing Records, ';
    }
    else if (req.body.records.length < 5 || req.body.records.length > 1000) {
      jobErrors += 'Invalid number of Records: '+req.body.records.length+', ';
    }
    else {
      logger.info(req.body.records.length + " records")
      records = [];
      for (let i = 0; i < req.body.records.length; i++) {
        
        if(req.body.records[i].resourceSource==SOURCE_FASTA){
          if (checkInput(req.body.records[i].id, 'string', FASTA_MET_UID_RE) &&
          (checkInput(req.body.records[i].geonameID, 'string', FASTA_MET_GEOID_RE) || checkInput(req.body.records[i].geonameID, 'string', FASTA_MET_LOCNAME_RE)) &&
          (checkInput(req.body.records[i].collectionDate, 'string', FASTA_MET_HUM_DATE_RE) || checkInput(req.body.records[i].collectionDate, 'string', FASTA_MET_DEC_DATE_RE)) &&
          checkInput(req.body.records[i].rawSequence, 'string', FASTA_MET_SEQ_RE)) {
            let rec = {
              id:String(req.body.records[i].id),
              collectionDate:String(req.body.records[i].collectionDate),
              geonameID:String(req.body.records[i].geonameID),
              rawSequence:String(req.body.records[i].rawSequence),
              resourceSource: String(req.body.records[i].resourceSource)
            };
            records.push(rec);
          }else {
            if(!jobErrors.includes("Invalid Records:"))
              jobErrors += 'Invalid Records: ';
            jobErrors += req.body.records[i].id+', ';
            let object = req.body.records[i];
            let output = '';
            for (let property in object) {
              output += property + ': ' + object[property]+'; ';
            }
            logger.info(output);
          }
        }
        else if(req.body.records[i].resourceSource==SOURCE_GENBANK){
          if (checkInput(req.body.records[i].id, 'string', ACCESSION_RE)) {
            let rec = {
              id:String(req.body.records[i].id),
              collectionDate:null,
              geonameID:null,
              rawSequence:null,
              resourceSource: String(req.body.records[i].resourceSource)
            };
            records.push(rec);
          }else{
            if(!jobErrors.includes("Invalid Records:"))
              jobErrors += 'Invalid Records: ';
            jobErrors += req.body.records[i].id+', ';
            break;
          }
        }
      }
    }
    let email = null;
    if (!req.body.replyEmail) {
      jobErrors += 'Missing Reply Email, ';
    }
    else if (checkInput(req.body.replyEmail, 'string', EMAIL_RE)) {
      email = String(req.body.replyEmail);
    }
    else {
      jobErrors += 'Invalid Email: '+req.body.replyEmail+', ';
    }
    let jobName = null;
    if (req.body.jobName) {
      if (checkInput(req.body.jobName, 'string', JOB_NAME_RE)) {
        jobName = String(req.body.jobName);
      }
      else {
        jobErrors += 'Invalid Job Name: '+req.body.jobName+', ';
      }
    }
    let useGLM = Boolean(req.body.useGLM === true);
    let predictors = null;
    if (useGLM && req.body.predictors !== undefined && req.body.predictors !== null) {
      logger.info('Job is using Custom Predictors');
      let predictorsAreValid = true;
      for (let state in req.body.predictors) {
        if (req.body.predictors.hasOwnProperty(state)) {
          if (!validatePredictor(state, req.body.predictors[state])) {
            predictorsAreValid = false;
          }
        }
      }
      if (predictorsAreValid) {
        predictors = req.body.predictors;
      }
      else {
        jobErrors += 'Invalid Custom Job Predictors, ';
      }
    }
    let xmlOptions = null;
    if (checkInput(req.body.xmlOptions.substitutionModel, 'string', SUB_MODEL_RE)){
      if (checkInput(req.body.xmlOptions.gamma, 'boolean', null)){
        if (checkInput(req.body.xmlOptions.invariantSites, 'boolean', null)){
          if (checkInput(req.body.xmlOptions.clockModel, 'string', CLOCK_MODEL_RE)){
            if (checkInput(req.body.xmlOptions.treePrior, 'string', PRIOR_RE)){
              if (checkInput(req.body.xmlOptions.chainLength, 'number', null)){
                if (checkInput(req.body.xmlOptions.subSampleRate, 'number', null)){
                  xmlOptions = {
                    substitutionModel: String(req.body.xmlOptions.substitutionModel),
                    gamma: Boolean(req.body.xmlOptions.gamma),
                    invariantSites: Boolean(req.body.xmlOptions.invariantSites),
                    clockModel: String(req.body.xmlOptions.clockModel),
                    treePrior: String(req.body.xmlOptions.treePrior),
                    chainLength: Number(req.body.xmlOptions.chainLength),
                    subSampleRate: Number(req.body.xmlOptions.subSampleRate)
                  };
                  console.log(xmlOptions);
                } else {jobErrors += 'Invalid XML Parameters: '+'subSampleRate';}
              } else {jobErrors += 'Invalid XML Parameters: '+'chainLength';}
            } else {jobErrors += 'Invalid XML Parameters: '+'treePrior';}
          } else {jobErrors += 'Invalid XML Parameters: '+'clockModel:';}
        } else {jobErrors += 'Invalid XML Parameters: '+'invariantSites';}
      } else {jobErrors += 'Invalid XML Parameters: '+'gamma';}
    } else {jobErrors += 'Invalid XML Parameters: '+'substitutionModel';}
    // else {
    //    jobErrors += 'Invalid XML Parameters, ';
    // }
    if (jobErrors === BASE_ERROR) {
      const zoophyJob = JSON.stringify({
        records: records,
        replyEmail: email,
        jobName: jobName,
        useGLM: useGLM,
        predictors: predictors,
        xmlOptions: xmlOptions
      });
      request.post({
        url: API_URI+'/validate',
        headers: {
          'Content-Type': 'application/json',
        },
        body: zoophyJob
      }, function(error, response, body) {
        if (error) {
          logger.error(error);
          result = {
            status: 500,
            error: String(error)
          };
          
          res.status(result.status).send(result);
        }
        else {
          let validationResults = JSON.parse(body);
          if (response.statusCode === 200 && validationResults.error === null) {
            logger.warn('Accessions removed in job validation: '+validationResults.accessionsRemoved);
            logger.info('Starting ZooPhy Job for: '+email+' with '+validationResults.accessionsUsed.length+' records.');
            logger.info('Starting ZooPhy Job for: '+email);
            logger.info(zoophyJob);
            request.post({
              url: API_URI+'/run',
              headers: {
                'Content-Type': 'application/json',
              },
              body: zoophyJob
            }, function(error, response, body) {
              if (error) {
                logger.error(error);
                result = {
                  status: 500,
                  error: 'Unknown ZooPhy API Error during Start'
                };
                res.status(result.status).send(result);
              }
              else {
                logger.info('Job Started: ', response.statusCode, body);
                if (response.statusCode === 202) {
                  result = {
                    status: 202,
                    message: String(body),
                    jobSize: validationResults.accessionsUsed.length,
                    recordsRemoved: validationResults.accessionsRemoved
                  };
                  logger.info(result)
                }
                else {
                  result = {
                    status: 500,
                    error: 'Unknown ZooPhy API Error during Start'
                  };
                }
                res.status(result.status).send(result);
              }
            }); 
        }  
        else if (validationResults.error) {
          logger.warn(validationResults.error);
          result = {
            status: 200,
            error: String(validationResults.error)
          };
          res.status(result.status).send(result);
        }
        else {
          logger.warn('Unknown ZooPhy API Error');
          result = {
            status: 200,
            error: 'Unknown ZooPhy API Error during Validation'
          };
          res.status(result.status).send(result);
        }
      }
      });
    }else {
        if (jobErrors.endsWith(', ')) {
           jobErrors = jobErrors.substring(0,jobErrors.length-2);
        }
        logger.warn(jobErrors);
         result = {
           status: 400,
           error: jobErrors
        };
         res.status(result.status).send(result);
       }
    }
  catch (err) {
    logger.error('Failed to start ZooPhy Job: '+err);
    result = {
      status: 500,
      error: 'Failed to start ZooPhy Job'
    };
    res.status(result.status).send(result);
  }
});

router.post('/predictors', upload.single('predictorsBatchFile'), function (req, res) {
  let result;
  try {
    logger.info('Setting Predictors...');
    if (req.file) {
      logger.info('Processing Predictor file upload...');
      let predictorFile = req.file;
      if (predictorFile.mimetype === 'text/tab-separated-values' && (checkInput(predictorFile.originalname, 'string', PREDICTOR_FILE_RE))) {
        fs.readFile(predictorFile.path, function (err, data) {
          if (err) {
            logger.error(error);
            result = {
              status: 500,
              error: String(error)
            };
            res.status(result.status).send(result);
          }
          else {
            let rawPredictorLines = data.toString().trim().split('\n');
            logger.info('Deleting valid file...');
            fs.unlink(predictorFile.path, function (err) {
              if (err) {
                logger.warn('Failed to delete valid file: '+predictorFile.path);
              }
              else {
                logger.info('Successfully deleted valid file.');
              }
            });
            let predictors = {};
            const predictorNames = rawPredictorLines[0].trim().split("\t");
            let invalidName = -1;
            for (let i = 0; i < predictorNames.length; i++) {
              if (!(checkInput(predictorNames[i], 'string', PREDICTOR_RE))) {
                invalidName = i;
                break;
              }
            }
            if (invalidName !== -1) {
              result = {
                status: 400,
                error: 'Invalid Predictor name: "'+predictorNames[invalidName]+'"'
              };
              res.status(result.status).send(result);
            }
            else {
              let stateError = null;
              for (let i = 1; i < rawPredictorLines.length && stateError == null; i++) {
                let stateLine = rawPredictorLines[i].trim().split("\t");
                const state = String(stateLine[0].trim());
                if (!(checkInput(state, 'string', STATE_RE))) {
                  stateError = state;
                  break;
                }
                let statePredictors = [];
                for (let j = 1; j < stateLine.length && stateError == null; j++) {
                  if (checkInput(stateLine[j],'number', null)) {
                    let predictor = new GLMPredictor(state, predictorNames[j], stateLine[j]);
                    statePredictors.push(predictor);
                  }
                  else {
                    stateError = stateLine[j];
                    break;
                  }
                }
                predictors[state] = statePredictors;
              }
              if (stateError === null) {
                result = {
                  status: 200,
                  predictors: predictors
                };
              }
              else {
                result = {
                  status: 400,
                  error: 'Invalid Predictor value: "'+stateError+'"'
                };
              }
              res.status(result.status).send(result);
            }
          }
        });
      }
      else {
        logger.warn('Deleting Invalid Predictor file...');
        fs.unlink(predictorFile.path, function (err) {
          if (err) {
            logger.error('Failed to delete invalid file: '+predictorFile.path);
          }
          else {
            logger.info('Successfully deleted invalid file.');
          }
        });
        result = {
          status: 400,
          error: 'Invalid Predictor File'
        };
        res.status(result.status).send(result);
      }
    }
    else {
      logger.warn('Missing Predictor File');
      result = {
        status: 400,
        error: 'Missing Predictor File'
      };
      res.status(result.status).send(result);
    }
  }
  catch (err) {
    logger.error('Failed to set Predictors: '+err);
    result = {
      status: 500,
      error: 'Failed to set Predictors'
    };
    res.status(result.status).send(result);
  }
});

function validatePredictor(state, predictors) {
  try {
    if ((predictors instanceof Array) && checkInput(state, 'string', STATE_RE)) {
      for (let i = 0; i < predictors.length; i++) {
        let predictor = predictors[i];
        if (!(typeof predictor === 'object' && Object.keys(predictor).length === 4 && predictor.state === state && checkInput(predictor.name, 'string', PREDICTOR_RE) && checkInput(predictor.value, 'number', null) && predictor.year === null)) {
          return false;
        }
      }
      return true;
    }
    else {
      return false;
    }
  }
  catch (err) {
    return false;
  }
};

function validateNumOfRecords(records) {
}  

module.exports = router;
