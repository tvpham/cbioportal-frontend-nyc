import * as _ from 'lodash';
import client from "../../api/cbioportalClientInstance";
import {ObservableMap, toJS, observable, reaction, action, computed, whyRun, expr, isObservableMap} from "mobx";
import {
	TypeOfCancer as CancerType, GeneticProfile, CancerStudy, SampleList, Gene,
	Sample, SampleIdentifier
} from "../../api/generated/CBioPortalAPI";
import CancerStudyTreeData from "./CancerStudyTreeData";
import {remoteData} from "../../api/remoteData";
import {labelMobxPromises, cached, debounceAsync} from "mobxpromise";
import internalClient from "../../api/cbioportalInternalClientInstance";
import oql_parser from "../../lib/oql/oql-parser";
import memoize from "memoize-weak-decorator";
import AppConfig from 'appConfig';
import {gsUploadByGet} from "../../api/gsuploadwindow";
import {OQLQuery} from "../../lib/oql/oql-parser";
import {ComponentGetsStoreContext} from "../../lib/ContextUtils";
import URL from 'url';
import {buildCBioPortalUrl, BuildUrlParams, getHost, openStudySummaryFormSubmit} from "../../api/urls";
import {SyntaxError} from "../../lib/oql/oql-parser";
import StudyListLogic from "./StudyListLogic";
import {QuerySession} from "../../lib/QuerySession";
import {stringListToIndexSet, stringListToSet} from "../../lib/StringUtils";
import chunkMapReduce from "shared/lib/chunkMapReduce";
import {VirtualCohort} from "../../../config/IAppConfig";
import request, {Response} from "superagent";
import formSubmit from "shared/lib/formSubmit";
import VirtualCohorts, {LocalStorageVirtualCohort} from "../../lib/VirtualCohorts";

// interface for communicating
type CancerStudyQueryUrlParams = {
	cancer_study_id: string,
	cancer_study_list?:string,
	genetic_profile_ids_PROFILE_MUTATION_EXTENDED: string,
	genetic_profile_ids_PROFILE_COPY_NUMBER_ALTERATION: string,
	genetic_profile_ids_PROFILE_MRNA_EXPRESSION: string,
	genetic_profile_ids_PROFILE_METHYLATION: string,
	genetic_profile_ids_PROFILE_PROTEIN_EXPRESSION: string,
	Z_SCORE_THRESHOLD: string,
	RPPA_SCORE_THRESHOLD: string,
	data_priority: '0'|'1'|'2',
	case_set_id: string,
	case_ids: string,
	gene_list: string,
	tab_index: 'tab_download'|'tab_visualize',
	transpose_matrix?: 'on',
	Action: 'Submit',
};

export type GeneReplacement = {alias: string, genes: Gene[]};

export const CUSTOM_CASE_LIST_ID = '-1';
export const ALL_CASES_LIST_ID = 'all';

function isInteger(str:string)
{
	return Number.isInteger(Number(str));
}

function normalizeQuery(geneQuery:string)
{
	return geneQuery.trim().replace(/^\s+|\s+$/g, '').replace(/[ \+]+/g, ' ').toUpperCase();
}

export type CancerStudyQueryParams = Pick<
	QueryStore,
	'searchText' |
	'selectedStudyIds' |
	'dataTypePriority' |
	'selectedProfileIds' |
	'zScoreThreshold' |
	'rppaScoreThreshold' |
	'selectedSampleListId' |
	'caseIds' |
	'caseIdsMode' |
	'geneQuery'
>;
export const QueryParamsKeys:(keyof CancerStudyQueryParams)[] = [
	'searchText',
	'selectedStudyIds',
	'dataTypePriority',
	'selectedProfileIds',
	'zScoreThreshold',
	'rppaScoreThreshold',
	'selectedSampleListId',
	'caseIds',
	'caseIdsMode',
	'geneQuery',
];

// mobx observable
export class QueryStore
{
	constructor(urlWithInitialParams?:string)
	{
		this.loadSavedVirtualCohorts();

		labelMobxPromises(this);
		if (urlWithInitialParams)
			this.setParamsFromUrl(urlWithInitialParams);

		this.addParamsFromWindow();
		this.setParamsFromQuerySession();
	}

	@observable userHasClickedOnAStudy:boolean = false;
	@observable savedVirtualCohorts:VirtualCohort[] = [];

	@action public deleteVirtualCohort(id:string) {
		VirtualCohorts.delete(id);

		this.loadSavedVirtualCohorts();
	}

	@action private loadSavedVirtualCohorts() {
		let localStorageVirtualCohorts:LocalStorageVirtualCohort[] = VirtualCohorts.get();
		this.savedVirtualCohorts = localStorageVirtualCohorts.map((x:any)=>{
			let samples:{studyId:string, sampleId:string}[] = [];
			const constituentStudyIds:string[] = [];
			for (const selectedCasesObj of x.selectedCases) {
				samples = samples.concat(selectedCasesObj.samples.map((sampleId:string)=>({studyId:selectedCasesObj.studyID, sampleId})));
				constituentStudyIds.push(selectedCasesObj.studyID);
			}
			return {
				id: x.virtualCohortID,
				name: x.studyName,
				description: x.description,
				samples,
				constituentStudyIds
			};
		});
	}

	@computed get virtualCohorts():VirtualCohort[] {
		const ret:VirtualCohort[] = [];
		if (this.temporaryVirtualCohort.result) {
			ret.push(this.temporaryVirtualCohort.result);
		}
		for (const cohort of this.savedVirtualCohorts) {
			ret.push(cohort);
		}
		return ret;
	}

	@computed get virtualCohortsSet():{[id:string]:VirtualCohort} {
		return this.virtualCohorts.reduce((acc:{[id:string]:VirtualCohort}, next:VirtualCohort)=>{
			acc[next.id] = next;
			return acc;
		}, {});
	}

	@computed get studyIdsInSelection():string[] {
		// Gives selected study ids and study ids that are in selected virtual cohorts
		const virtualCohortsSet = this.virtualCohortsSet;
		const ret:{[id:string]:boolean} = {};
		for (const studyId of this.selectedStudyIds) {
			const vc = virtualCohortsSet[studyId];
			if (vc) {
				for (const constStudyId of vc.constituentStudyIds) {
					ret[constStudyId] = true;
				}
			} else {
				ret[studyId] = true;
			}
		}
		return Object.keys(ret);
	}

	readonly temporaryVirtualCohortId = remoteData({
		await:()=>[this.cancerStudies],
		invoke: async ()=>{
			const knownStudies:{[studyId:string]:boolean} = {};
			for (const study of this.cancerStudies.result) {
				knownStudies[study.studyId] = true;
			}
			for (const study of this.savedVirtualCohorts) {
				knownStudies[study.id] = true;
			}
			const candidates = ((window as any).cohortIdsList as string[]) || [];
			const temporary = candidates.filter(x=>!knownStudies[x]);
			if (temporary.length === 0) {
				return undefined;
			} else {
				return temporary[0];
			}
		}
	});

	readonly temporaryVirtualCohort = remoteData<VirtualCohort|undefined>({
		await: ()=>[this.temporaryVirtualCohortId],
		invoke: async ()=>{
			if (!this.temporaryVirtualCohortId.result) {
				return undefined;
			}
			try {
				const virtualCohortData:Response = await request.get(`${window.location.protocol}//${getHost()}/api-legacy/proxy/session-service/virtual_cohort/${this.temporaryVirtualCohortId.result}`);
				const virtualCohortJSON = JSON.parse(virtualCohortData.text);
				const name:string = virtualCohortJSON.data.studyName as string;
				const description:string = virtualCohortJSON.data.description as string;
				let samples:{sampleId:string, studyId:string}[] = [];
				const constituentStudyIds:string[] = [];
				for (const selectedCasesObj of virtualCohortJSON.data.selectedCases) {
					samples = samples.concat(selectedCasesObj.samples.map((sampleId:string)=>({studyId:selectedCasesObj.studyID, sampleId})));
					constituentStudyIds.push(selectedCasesObj.studyID);
				}
				return {
					id: this.temporaryVirtualCohortId.result,
					name,
					description,
					samples,
					constituentStudyIds
				};
			} catch (e) {
				// In case anything related to fetching this data fails
				return undefined;
			}
		},
		onResult:(vc?:VirtualCohort)=>{
			if (vc) {
				this.selectedSampleListId = CUSTOM_CASE_LIST_ID;
				this.caseIdsMode = "sample";
				this.caseIds = vc.samples.map(sample=>`${sample.studyId}:${sample.sampleId}`).join("\n");
			}
		}
	});

	copyFrom(other:CancerStudyQueryParams)
	{
		// download tab does not appear anywhere except home page
		this.forDownloadTab = false;

		for (let key of QueryParamsKeys)
			this[key] = other[key];
	}

	@computed get stateToSerialize()
	{
		return _.pick(this, QueryParamsKeys);
	}

	////////////////////////////////////////////////////////////////////////////////
	// QUERY PARAMETERS
	////////////////////////////////////////////////////////////////////////////////

	@observable forDownloadTab:boolean = false;

	@observable transposeDataMatrix = false;

	@observable searchText:string = '';

	@observable private _selectedStudyIds:ObservableMap<boolean> = observable.map<boolean>();
	@computed get selectedStudyIds():string[]
	{
		let ids:string[] = this._selectedStudyIds.keys();
		const selectableStudies = this.selectableStudiesSet;
		ids = ids.filter(id=>!!selectableStudies[id]);
		return this.forDownloadTab ? ids.slice(-1) : ids;
	}
	set selectedStudyIds(val:string[]) {
		this._selectedStudyIds = observable.map(stringListToSet(val));
	}

	@action public setStudyIdSelected(studyId:string, selected:boolean) {
		if (this.forDownloadTab) {
			// only one can be selected at a time
			let newMap:{[studyId:string]:boolean} = {};
			if (selected) {
				newMap[studyId] = selected;
			}
			this._selectedStudyIds = observable.map(newMap);
		} else {
			if (selected) {
				this._selectedStudyIds.set(studyId, true);
			} else {
				this._selectedStudyIds.delete(studyId);
			}
		}
	}
	private isStudyIdSelected(studyId:string):boolean {
		return !!this._selectedStudyIds.get(studyId);
	}

	@observable dataTypePriority = {mutation: true, cna: true};

	// genetic profile ids
	@observable.ref private _selectedProfileIds?:ReadonlyArray<string> = undefined; // user selection
	@computed get selectedProfileIds():ReadonlyArray<string>
	{
		let selectedIds;

		if (this._selectedProfileIds !== undefined)
		{
			selectedIds = this._selectedProfileIds;
		}
		else
		{
			// compute default selection
			const altTypes:GeneticProfile['geneticAlterationType'][] = [
				'MUTATION_EXTENDED',
				'COPY_NUMBER_ALTERATION',
			];
			selectedIds = [];
			for (let altType of altTypes)
			{
				let profiles = this.getFilteredProfiles(altType);
				if (profiles.length)
					selectedIds.push(profiles[0].geneticProfileId);
			}
		}

		// download tab only allows one selected profile
		if (this.forDownloadTab)
			return selectedIds.slice(0, 1);

		// query tab only allows selecting profiles with showProfileInAnalysisTab=true
		return selectedIds.filter(id => {
			let profile = this.dict_geneticProfileId_geneticProfile[id];
			return profile && profile.showProfileInAnalysisTab;
		});
	}
	set selectedProfileIds(value)
	{
		this._selectedProfileIds = value;
	}

	@observable zScoreThreshold:string = '2.0';

	@observable rppaScoreThreshold:string = '2.0';

	// sample list id
	@observable private _selectedSampleListId?:string = undefined; // user selection
	@computed get selectedSampleListId()
	{
		if (this._selectedSampleListId !== undefined)
			return this._selectedSampleListId;
		return this.defaultSelectedSampleListId;
	}
	set selectedSampleListId(value)
	{
		this._selectedSampleListId = value;
	}

	@observable caseIds = '';

	@observable _caseIdsMode:'sample'|'patient' = 'sample';
	@computed get caseIdsMode()
	{
		return this.selectedSampleListId === CUSTOM_CASE_LIST_ID ? this._caseIdsMode : 'sample';
	}
	set caseIdsMode(value)
	{
		this._caseIdsMode = value;
	}

	@observable _geneQuery = '';
	get geneQuery()
	{
		return this._geneQuery;
	}
	set geneQuery(value:string)
	{
		// clear error when gene query is modified
		this.geneQueryErrorDisplayStatus = 'unfocused';
		this._geneQuery = value;
	}

	////////////////////////////////////////////////////////////////////////////////
	// VISUAL OPTIONS
	////////////////////////////////////////////////////////////////////////////////

	@observable geneQueryErrorDisplayStatus:'unfocused'|'shouldFocus'|'focused' = 'unfocused';
	@observable showMutSigPopup = false;
	@observable showGisticPopup = false;
	@observable.ref searchTextPresets:ReadonlyArray<string> = AppConfig.cancerStudySearchPresets;
	@observable priorityStudies = AppConfig.priorityStudies;
	@observable showSelectedStudiesOnly:boolean = false;
	@observable.shallow selectedCancerTypeIds:string[] = [];
	@observable clickAgainToDeselectSingle:boolean = true;
	@observable searchExampleMessage = "";

	@observable private _maxTreeDepth:number = (window as any).maxTreeDepth;
	@computed get maxTreeDepth()
	{
		return (this.forDownloadTab && this._maxTreeDepth > 0) ? 1 : this._maxTreeDepth;
	}
	set maxTreeDepth(value)
	{
		this._maxTreeDepth = value;
	}


	////////////////////////////////////////////////////////////////////////////////
	// REMOTE DATA
	////////////////////////////////////////////////////////////////////////////////

	readonly cancerTypes = remoteData({
		invoke: async () => {
			return client.getAllCancerTypesUsingGET({}).then((data)=>{
				// all types should have parent. this is a correction for a data issue
				// where there IS a top level (parent=null) item
				return data.filter(cancerType => {
					return cancerType.parent !== 'null';
				});
			});
		}
	}, []);

	readonly cancerStudies = remoteData(client.getAllStudiesUsingGET({}), []);
	readonly cancerStudyIdsSet = remoteData({
		await: ()=>[this.cancerStudies],
		invoke: async ()=>{
			return stringListToSet(this.cancerStudies.result.map(x=>x.studyId));
		},
		default: {},
	});

	@computed get selectableStudiesSet():{[studyId:string]:boolean} {
		const ret = Object.assign({}, this.cancerStudyIdsSet.result);
		for (const cohort of this.virtualCohorts) {
			ret[cohort.id] = true;
		}
		return ret;
	}

	readonly geneticProfiles = remoteData<GeneticProfile[]>({
		invoke: async () => {
			if (!this.singleSelectedStudyId)
				return [];
			return await client.getAllGeneticProfilesInStudyUsingGET({
				studyId: this.singleSelectedStudyId
			});
		},
		default: [],
		onResult: () => {
			if (!this.initiallySelected.profileIds || this.userHasClickedOnAStudy) {
				this._selectedProfileIds = undefined;
			}
		}
	});

	readonly sampleLists = remoteData({
		invoke: async () => {
			if (!this.isSingleNonVirtualStudySelected) {
				return [];
			}
			let sampleLists = await client.getAllSampleListsInStudyUsingGET({
				studyId: this.selectedStudyIds[0],
				projection: 'DETAILED'
			});
			return _.sortBy(sampleLists, sampleList => sampleList.name);
		},
		default: [],
		onResult: () => {
			if (!this.initiallySelected.sampleListId || this.userHasClickedOnAStudy) {
				this._selectedSampleListId = undefined;
			}
		}
	});

	readonly mutSigForSingleStudy = remoteData({
		invoke: async () => {
			if (!this.isSingleNonVirtualStudySelected) {
				return [];
			}
			return await internalClient.getSignificantlyMutatedGenesUsingGET({
				studyId: this.selectedStudyIds[0]
			});
		},
		default: []
	});

	readonly gisticForSingleStudy = remoteData({
		invoke: async () => {
			if (!this.isSingleNonVirtualStudySelected) {
				return [];
			}
			return await internalClient.getSignificantCopyNumberRegionsUsingGET({
				studyId: this.selectedStudyIds[0]
			});
		},
		default: []
	});

	readonly genes = remoteData({
		invoke: () => this.invokeGenesLater(this.geneIds),
		default: {found: [], suggestions: []}
	});

	private invokeGenesLater = debounceAsync(
		async (geneIds:string[]):Promise<{found: Gene[], suggestions: GeneReplacement[]}> =>
		{
			let [entrezIds, hugoIds] = _.partition(_.uniq(geneIds), isInteger);

			let getEntrezResults = async () => {
				let found:Gene[];
				if (entrezIds.length)
					found = await client.fetchGenesUsingPOST({geneIdType: "ENTREZ_GENE_ID", geneIds: entrezIds});
				else
					found = [];
				let missingIds = _.difference(entrezIds, found.map(gene => gene.entrezGeneId + ''));
				let removals = missingIds.map(entrezId => ({alias: entrezId, genes: []}));
				let replacements = found.map(gene => ({alias: gene.entrezGeneId + '', genes: [gene]}));
				let suggestions = [...removals, ...replacements];
				return {found, suggestions};
			};

			let getHugoResults = async () => {
				let found:Gene[];
				if (hugoIds.length)
					found = await client.fetchGenesUsingPOST({geneIdType: "HUGO_GENE_SYMBOL", geneIds: hugoIds});
				else
					found = [];
				let missingIds = _.difference(hugoIds, found.map(gene => gene.hugoGeneSymbol));
				let suggestions = await Promise.all(missingIds.map(alias => this.getGeneSuggestions(alias)));
				return {found, suggestions};
			};

			let [entrezResults, hugoResults] = await Promise.all([getEntrezResults(), getHugoResults()]);
			return {
				found: [...entrezResults.found, ...hugoResults.found],
				suggestions: [...entrezResults.suggestions, ...hugoResults.suggestions]
			};
		},
		500
	);

	@memoize
	async getGeneSuggestions(alias:string):Promise<GeneReplacement>
	{
		return {
			alias,
			genes: await client.getAllGenesUsingGET({alias})
		};
	}

	@memoize
	getSamplesForStudyAndPatient(studyId:string, patientId:string)
	{
		return client.getAllSamplesOfPatientInStudyUsingGET({studyId, patientId})
			.then(
				samples => ({studyId, patientId, samples, error: undefined}),
				error => ({studyId, patientId, samples: [] as Sample[], error})
			);
	}

	readonly asyncCustomCaseSetUrlParam = remoteData({
		await: ()=>[this.asyncCustomCaseSet],
		invoke: async ()=>{
			return this.asyncCustomCaseSet.result.map(x=>`${x.studyId}\t${x.sampleId}`).join('\r\n');
		},
		default: ''
	});

	readonly asyncCustomCaseSet = remoteData<{sampleId:string, studyId:string}[]>({
		invoke: async () => {
			if (this.selectedSampleListId !== CUSTOM_CASE_LIST_ID || (this.caseIds.trim().length === 0))
				return [];
			return this.invokeCustomCaseSetLater({
				singleSelectedStudyId: this.singleSelectedStudyId,
				isVirtualCohortSelected: this.isVirtualCohortSelected,
				caseIds: this.caseIds,
				caseIdsMode: this.caseIdsMode,
			})
		},
		default: []
	});

	private invokeCustomCaseSetLater = debounceAsync(
		async (params:Pick<this, 'singleSelectedStudyId' | 'isVirtualCohortSelected' | 'caseIds' | 'caseIdsMode'>) => {
			let singleSelectedStudyId = '';
			if (this.isSingleNonVirtualStudySelected) {
				singleSelectedStudyId = this.selectedStudyIds[0];
			}
			let entities = params.caseIds.trim().split(/\s+/g);
			const studyIdsInSelectionSet = stringListToSet(this.studyIdsInSelection);
			const cases:{id:string, study:string}[] = entities.map(entity=>{
				let splitEntity = entity.split(':');
				if (splitEntity.length === 1) {
					// no study specified
					if (singleSelectedStudyId) {
						// if only one study selected, fill it in
						return {
							id: entity,
							study: singleSelectedStudyId
						};
					} else {
						// otherwise, throw error
						throw new Error(`No study specified for ${this.caseIdsMode} id: ${entity}, and more than one study selected for query.`);
					}
				} else if (splitEntity.length === 2) {
					const study = splitEntity[0];
					const id = splitEntity[1];
					if (!studyIdsInSelectionSet[study]) {
						let virtualCohortMessagePart = '';
						if (this.isVirtualCohortSelected) {
							virtualCohortMessagePart = ', nor part of a selected Saved Cohort';
						}
						throw new Error(`Study ${study} is not selected${virtualCohortMessagePart}.`);
					}
					return {
						id,
						study
					};
				} else {
					throw new Error(`Input error for entity: ${entity}.`);
				}
			});
			const caseOrder = stringListToIndexSet(cases.map(x=>`${x.study}:${x.id}`));
			let retSamples:{sampleId:string, studyId:string}[] = [];
			const validIds:{[studyColonId:string]:boolean} = {};
			let invalidIds:{id:string, study:string}[] = [];
			if (params.caseIdsMode === 'sample')
			{
				const sampleIdentifiers = cases.map(c => ({studyId: c.study, sampleId: c.id}));
				if (sampleIdentifiers.length)
				{
					let sampleObjs = await chunkMapReduce(sampleIdentifiers, chunk=>client.fetchSamplesUsingPOST({sampleIdentifiers:chunk, projection: "SUMMARY"}), 990);
					// sort by input order
					sampleObjs = _.sortBy(sampleObjs, sampleObj=>caseOrder[`${sampleObj.studyId}:${sampleObj.sampleId}`]);

					for (const sample of sampleObjs) {
						retSamples.push({studyId: sample.studyId, sampleId: sample.sampleId});
						validIds[`${sample.studyId}:${sample.sampleId}`] = true;
					}
				}
			}
			else
			{
				// convert patient IDs to sample IDs
				const samplesPromises = cases.map(c => this.getSamplesForStudyAndPatient(c.study, c.id));
				let result:{studyId:string, patientId:string, samples:Sample[], error?:Error}[] = await Promise.all(samplesPromises);
				// sort by input order
				result = _.sortBy(result, obj=>caseOrder[`${obj.studyId}:${obj.patientId}`]);

				for (const {studyId, patientId, samples, error} of result)
				{
					if (!error && samples.length) {
						retSamples = retSamples.concat(samples.map(sample=>{
							validIds[`${sample.studyId}:${sample.patientId}`] = true;
							return {
								studyId:sample.studyId,
								sampleId:sample.sampleId
							};
						}));
					}
				}
			}

			invalidIds = invalidIds.concat(cases.filter(x=>(!validIds[`${x.study}:${x.id}`])));

			if (invalidIds.length) {
				if (this.isSingleNonVirtualStudySelected) {
					throw new Error(
						`Invalid ${
							params.caseIdsMode
						}${
							invalidIds.length > 1 ? 's' : ''
						} for the selected cancer study: ${
							invalidIds.map(x=>x.id).join(', ')
						}`
					);
				} else {
					throw new Error(
						`Invalid (study, ${
							params.caseIdsMode
						}) pair${
						invalidIds.length > 1 ? 's' : ''
						}: ${invalidIds.map(x=>`(${x.study}, ${x.id})`).join(', ')}
						`
					);
				}
			}

			return retSamples;
		},
		500
	);


	////////////////////////////////////////////////////////////////////////////////
	// DERIVED DATA
	////////////////////////////////////////////////////////////////////////////////

	// CANCER STUDY

	@cached get treeData()
	{
		return new CancerStudyTreeData({
			cancerTypes: this.cancerTypes.result,
			studies: this.cancerStudies.result,
			priorityStudies: this.priorityStudies,
			virtualCohorts: this.virtualCohorts
		});
	}

	readonly studyListLogic = new StudyListLogic(this);

	@computed get selectedCancerTypes()
	{
		return this.selectedCancerTypeIds.map(id => this.treeData.map_cancerTypeId_cancerType.get(id) as CancerType).filter(_.identity);
	}

	@computed get singleSelectedStudyId()
	{
		return this.selectedStudyIds.length == 1 ? this.selectedStudyIds[0] : undefined;
	}

	@computed get selectedStudies()
	{
		return this.selectedStudyIds.map(id => this.treeData.map_studyId_cancerStudy.get(id) as CancerStudy).filter(_.identity);
	}

	@computed get selectedStudies_totalSampleCount()
	{
		return this.selectedStudies.reduce((sum:number, study:CancerStudy) => sum + study.allSampleCount, 0);
	}

	public isVirtualCohort(studyId:string):boolean {
		// if the study id doesn't correspond to one in this.cancerStudies, then its a virtual cohort
		return !this.cancerStudyIdsSet.result[studyId];
	}

	public isTemporaryVirtualCohort(studyId:string):boolean {
		return !this.temporaryVirtualCohortId.result || this.temporaryVirtualCohortId.result === studyId;
	}

	private isSingleStudySelected(shouldBeVirtualCohort:boolean) {
		if (this.selectedStudyIds.length !== 1) {
			return false;
		}
		const selectedStudyId = this.selectedStudyIds[0];
		return (this.isVirtualCohort(selectedStudyId) === shouldBeVirtualCohort);
	}

	@computed public get isSingleVirtualCohortSelected() {
		return this.isSingleStudySelected(true);
	}

	@computed public get isSingleNonVirtualStudySelected() {
		return this.isSingleStudySelected(false);
	}

	@computed public get isVirtualCohortSelected() {
		let ret = false;
		const virtualCohorts = this.virtualCohortsSet;
		for (const studyId of this.selectedStudyIds) {
			if (virtualCohorts[studyId]) {
				ret = true;
				break;
			}
		}
		return ret;
	}

	@computed public get isVirtualCohortQuery() {
		if (this.selectedStudyIds.length === 0) {
			return false;
		} else if (this.selectedStudyIds.length > 1) {
			return true;
		} else {
			return this.isSingleVirtualCohortSelected;
		}
	}

	// DATA TYPE PRIORITY

	@computed get dataTypePriorityCode():'0'|'1'|'2'
	{
		let {mutation, cna} = this.dataTypePriority;
		if (mutation && cna)
			return '0';
		if (mutation)
			return '1';
		if (cna)
			return '2';

		return '0';
	}
	set dataTypePriorityCode(code:'0'|'1'|'2')
	{
		switch (code)
		{
			default:
			case '0':
				this.dataTypePriority = {mutation: true, cna: true};
				break;
			case '1':
				this.dataTypePriority = {mutation: true, cna: false};
				break;
			case '2':
				this.dataTypePriority = {mutation: false, cna: true};
				break;
		}
	}

	// GENETIC PROFILE

	@computed get dict_geneticProfileId_geneticProfile():_.Dictionary<GeneticProfile | undefined>
	{
		return _.keyBy(this.geneticProfiles.result, profile => profile.geneticProfileId);
	}

	getFilteredProfiles(geneticAlterationType:GeneticProfile['geneticAlterationType'])
	{
		return this.geneticProfiles.result.filter(profile => {
			if (profile.geneticAlterationType != geneticAlterationType)
				return false;

			return profile.showProfileInAnalysisTab || this.forDownloadTab;
		});
	}

	isProfileSelected(geneticProfileId:string)
	{
		return _.includes(this.selectedProfileIds, geneticProfileId);
	}

	getSelectedProfileIdFromGeneticAlterationType(geneticAlterationType:GeneticProfile['geneticAlterationType']):string
	{
		for (let profileId of this.selectedProfileIds)
		{
			let profile = this.dict_geneticProfileId_geneticProfile[profileId];
			if (profile && profile.geneticAlterationType == geneticAlterationType)
				return profile.geneticProfileId;
		}
		return '';
	}

	// SAMPLE LIST

	@computed get defaultSelectedSampleListId()
	{
		if (this.isVirtualCohortQuery) {
			return ALL_CASES_LIST_ID;
		}

		let studyId = this.singleSelectedStudyId;
		if (!studyId)
			return undefined;

		let mutSelect = this.getSelectedProfileIdFromGeneticAlterationType('MUTATION_EXTENDED');
		let cnaSelect = this.getSelectedProfileIdFromGeneticAlterationType('COPY_NUMBER_ALTERATION');
		let expSelect = this.getSelectedProfileIdFromGeneticAlterationType('MRNA_EXPRESSION');
		let rppaSelect = this.getSelectedProfileIdFromGeneticAlterationType('PROTEIN_LEVEL');
		let sampleListId = studyId + "_all";

		if (mutSelect && cnaSelect && !expSelect && !rppaSelect)
			sampleListId = studyId + "_cnaseq";
		else if (mutSelect && !cnaSelect && !expSelect && !rppaSelect)
			sampleListId = studyId + "_sequenced";
		else if (!mutSelect && cnaSelect && !expSelect && !rppaSelect)
			sampleListId = studyId + "_acgh";
		else if (!mutSelect && !cnaSelect && expSelect && !rppaSelect)
		{
			if (this.isProfileSelected(studyId + '_mrna_median_Zscores'))
				sampleListId = studyId + "_mrna";
			else if (this.isProfileSelected(studyId + '_rna_seq_mrna_median_Zscores'))
				sampleListId = studyId + "_rna_seq_mrna";
			else if (this.isProfileSelected(studyId + '_rna_seq_v2_mrna_median_Zscores'))
				sampleListId = studyId + "_rna_seq_v2_mrna";
		}
		else if ((mutSelect || cnaSelect) && expSelect && !rppaSelect)
			sampleListId = studyId + "_3way_complete";
		else if (!mutSelect && !cnaSelect && !expSelect && rppaSelect)
			sampleListId = studyId + "_rppa";

		// BEGIN HACK if not found
		if (!this.dict_sampleListId_sampleList[sampleListId])
		{
			if (sampleListId === studyId + '_cnaseq')
				sampleListId = studyId + '_cna_seq';
			else if (sampleListId === studyId + "_3way_complete")
				sampleListId = studyId + "_complete";
		}
		// END HACK

		// if still not found
		if (!this.dict_sampleListId_sampleList[sampleListId])
			sampleListId = studyId + '_all';

		return sampleListId;
	}

	@computed get dict_sampleListId_sampleList():_.Dictionary<SampleList | undefined>
	{
		return _.keyBy(this.sampleLists.result, sampleList => sampleList.sampleListId);
	}

	// GENES

	@computed get oql():{ query: OQLQuery, error?: { start: number, end: number, message: string } }
	{
		try
		{
			return {
				query: this.geneQuery && oql_parser.parse(this.geneQuery.trim().toUpperCase()) || [],
				error: undefined
			};
		}
		catch (error)
		{
			if (error.name !== 'SyntaxError')
				return {
					query: [],
					error: {start: 0, end: 0, message: `Unexpected ${error}`}
				};

			let {offset} = error as SyntaxError;
			let near, start, end;
			if (offset === this.geneQuery.length)
				[near, start, end] = ['after', offset - 1, offset];
			else if (offset === 0)
				[near, start, end] = ['before', offset, offset + 1];
			else
				[near, start, end] = ['at', offset, offset + 1];
			let message = `OQL syntax error ${near} selected character; please fix and submit again.`;
			return {
				query: [],
				error: {start, end, message}
			};
		}
	}

	@computed get geneIds():string[]
	{
		try
		{
			return this.oql.query.map(line => line.gene).filter(gene => gene && gene !== 'DATATYPES');
		}
		catch (e)
		{
			return [];
		}
	}

	// SUBMIT

	@computed get submitEnabled()
	{
		return (
			!this.submitError &&
			this.genes.isComplete &&
			this.asyncUrlParams.isComplete
		) || !!this.oql.error; // to make "Please click 'Submit' to see location of error." possible
	}

	@computed get summaryEnabled() {
		return this.selectedStudyIds.length > 0;
	}

	@computed get submitError()
	{
		let haveExpInQuery = this.oql.query.some(result => {
			return (result.alterations || []).some(alt => alt.alteration_type === 'exp');
		});

		if (!this.selectedStudyIds.length)
			return "Please select one or more cancer studies.";

		if (this.isSingleNonVirtualStudySelected)
		{
			if (!this.selectedProfileIds.length)
				return "Please select one or more genetic profiles.";

			let expProfileSelected = this.getSelectedProfileIdFromGeneticAlterationType('MRNA_EXPRESSION');
			if (haveExpInQuery && !expProfileSelected)
				return "Expression specified in the list of genes, but not selected in the Genetic Profile Checkboxes.";

		}
		if (this.selectedStudyIds.length && this.selectedSampleListId === CUSTOM_CASE_LIST_ID)
		{
			if (this.asyncCustomCaseSet.isComplete && !this.asyncCustomCaseSet.result.length)
				return "Please enter at least one ID in your custom case set.";
			if (this.asyncCustomCaseSet.error)
				return "Error in custom case set.";
		}
		else if (haveExpInQuery)
		{
			return "Expression filtering in the gene list is not supported when doing cross cancer queries.";
		}

		if (!this.oql.query.length)
			return "Please enter one or more gene symbols.";

		if (this.genes.result.suggestions.length)
			return "Please edit the gene symbols.";
	}

	private readonly dict_geneticAlterationType_filenameSuffix:{[K in GeneticProfile['geneticAlterationType']]?: string} = {
		"MUTATION_EXTENDED": 'mutations',
		"COPY_NUMBER_ALTERATION": 'cna',
		"MRNA_EXPRESSION": 'mrna',
		"METHYLATION": 'methylation',
		"METHYLATION_BINARY": 'methylation',
		"PROTEIN_LEVEL": 'rppa',
	};

	@computed get downloadDataFilename()
	{
		let study = this.singleSelectedStudyId && this.treeData.map_studyId_cancerStudy.get(this.singleSelectedStudyId);
		let profile = this.dict_geneticProfileId_geneticProfile[this.selectedProfileIds[0] as string];

		if (!this.forDownloadTab || !study || !profile)
			return 'cbioportal-data.txt';

		let suffix = this.dict_geneticAlterationType_filenameSuffix[profile.geneticAlterationType] || profile.geneticAlterationType.toLowerCase();
		return `cbioportal-${study.studyId}-${suffix}.txt`;
	}

	readonly asyncUrlParams = remoteData({
		await: () => [this.asyncCustomCaseSetUrlParam],
		invoke: async () => {
			let params: CancerStudyQueryUrlParams = {
				cancer_study_id: this.singleSelectedStudyId || 'all',
				genetic_profile_ids_PROFILE_MUTATION_EXTENDED: this.getSelectedProfileIdFromGeneticAlterationType("MUTATION_EXTENDED"),
				genetic_profile_ids_PROFILE_COPY_NUMBER_ALTERATION: this.getSelectedProfileIdFromGeneticAlterationType("COPY_NUMBER_ALTERATION"),
				genetic_profile_ids_PROFILE_MRNA_EXPRESSION: this.getSelectedProfileIdFromGeneticAlterationType("MRNA_EXPRESSION"),
				genetic_profile_ids_PROFILE_METHYLATION: this.getSelectedProfileIdFromGeneticAlterationType("METHYLATION") || this.getSelectedProfileIdFromGeneticAlterationType("METHYLATION_BINARY"),
				genetic_profile_ids_PROFILE_PROTEIN_EXPRESSION: this.getSelectedProfileIdFromGeneticAlterationType("PROTEIN_LEVEL"),
				Z_SCORE_THRESHOLD: this.zScoreThreshold,
				RPPA_SCORE_THRESHOLD: this.rppaScoreThreshold,
				data_priority: this.dataTypePriorityCode,
				case_set_id: ((!this.selectedSampleListId || this.selectedSampleListId === CUSTOM_CASE_LIST_ID) ? '-1' : this.selectedSampleListId),
				case_ids: this.asyncCustomCaseSetUrlParam.result,
				gene_list: this.geneQuery || ' ', // empty string won't work
				tab_index: this.forDownloadTab ? 'tab_download' : 'tab_visualize' as any,
				transpose_matrix: this.transposeDataMatrix ? 'on' : undefined,
				Action: 'Submit',
			};

			// Remove params with no value, because they may cause problems.
			// For example, the server will always transpose if transpose_matrix is present, no matter the value.
			for (let key in params)
				if (!(params as any)[key])
					delete (params as any)[key];

			if (this.selectedStudyIds.length != 1)
			{
				params.cancer_study_list = this.selectedStudyIds.join(",");
			}

			return {pathname: 'index.do', query: params};
		}
	});

	////////////////////////////////////////////////////////////////////////////////
	// ACTIONS
	////////////////////////////////////////////////////////////////////////////////

	@action setParamsFromQuerySession() {
		const querySession:QuerySession|undefined = (window as any).QuerySession;
		if (querySession) {
			this._selectedProfileIds = querySession.getGeneticProfileIds();
			this.zScoreThreshold = (querySession.getZScoreThreshold()+"") || "2.0";
			this.rppaScoreThreshold = (querySession.getRppaScoreThreshold()+"") || "2.0";
			this.selectedSampleListId = querySession.getCaseSetId();
			if (this.selectedSampleListId === "-1") {
				// legacy compatibility
				this.selectedSampleListId = CUSTOM_CASE_LIST_ID;
			}
			this.caseIds = querySession.getSampleIds().join("\n");
			this.caseIdsMode = 'sample'; // url always contains sample IDs
			this.geneQuery = normalizeQuery(querySession.getOQLQuery());
			this.initiallySelected.profileIds = true;
			this.initiallySelected.sampleListId = true;
		}
	}

	/**
	 * This is used to prevent selections from being cleared automatically when new data is downloaded.
	 */
	private readonly initiallySelected = {
		profileIds: false,
		sampleListId: false
	};

	@action addParamsFromWindow()
	{
		// Select studies from window
		const windowStudyId = (window as any).selectedCancerStudyId;
		if (windowStudyId) {
			this.setStudyIdSelected(windowStudyId, true);
		}

		const cohortIdsList:string[] = ((window as any).cohortIdsList as string[]) || [];
		for (const studyId of cohortIdsList) {
			if (studyId !== "null") {
				this.setStudyIdSelected(studyId, true);
			}
		}

		const windowSampleIds:string = (window as any).selectedSampleIds;
		if (windowSampleIds) {
			this.selectedSampleListId = CUSTOM_CASE_LIST_ID;
			this.caseIdsMode = 'sample';
			this.caseIds = windowSampleIds.split(/\s+/).join("\n");
			this.initiallySelected.sampleListId = true;
		}
	}

	@action setParamsFromUrl(url:string)
	{
		let urlParts = URL.parse(url, true);
		let params = urlParts.query as Partial<CancerStudyQueryUrlParams>;
		let profileIds = [
			params.genetic_profile_ids_PROFILE_MUTATION_EXTENDED,
			params.genetic_profile_ids_PROFILE_COPY_NUMBER_ALTERATION,
			params.genetic_profile_ids_PROFILE_MRNA_EXPRESSION,
			params.genetic_profile_ids_PROFILE_METHYLATION,
			params.genetic_profile_ids_PROFILE_PROTEIN_EXPRESSION,
		];

		this.selectedStudyIds = params.cancer_study_list ? params.cancer_study_list.split(",") : (params.cancer_study_id ? [params.cancer_study_id] : []);
		this._selectedProfileIds = profileIds.every(id => id === undefined) ? undefined : profileIds.filter(_.identity) as string[];
		this.zScoreThreshold = params.Z_SCORE_THRESHOLD || '2.0';
		this.rppaScoreThreshold = params.RPPA_SCORE_THRESHOLD || '2.0';
		this.dataTypePriorityCode = params.data_priority || '0';
		this.selectedSampleListId = params.case_set_id !== "-1" ? params.case_set_id : '';
		this.caseIds = params.case_ids || '';
		this.caseIdsMode = 'sample'; // url always contains sample IDs
		this.geneQuery = normalizeQuery(params.gene_list || '');
		this.forDownloadTab = params.tab_index === 'tab_download';
		this.initiallySelected.profileIds = true;
		this.initiallySelected.sampleListId = true;
	}

	@action selectCancerType(cancerType:CancerType, multiSelect?:boolean)
	{
		let clickedCancerTypeId = cancerType.cancerTypeId;

		if (multiSelect)
		{
			if (_.includes(this.selectedCancerTypeIds, clickedCancerTypeId))
				this.selectedCancerTypeIds = _.difference(this.selectedCancerTypeIds, [clickedCancerTypeId]);
			else
				this.selectedCancerTypeIds = _.union(this.selectedCancerTypeIds, [clickedCancerTypeId]);
		}
		else if (this.clickAgainToDeselectSingle && _.isEqual(toJS(this.selectedCancerTypeIds), [clickedCancerTypeId]))
		{
			this.selectedCancerTypeIds = [];
		}
		else
		{
			this.selectedCancerTypeIds = [clickedCancerTypeId];
		}
	}

	@action setSearchText(searchText: string) {
		this.clearSelectedCancerType();
		this.searchText = searchText;
	}

	@action clearSelectedCancerType(){
		this.selectedCancerTypeIds = [];
	}

	@action selectGeneticProfile(profile:GeneticProfile, checked:boolean)
	{
		let groupProfiles = this.getFilteredProfiles(profile.geneticAlterationType);
		let groupProfileIds = groupProfiles.map(profile => profile.geneticProfileId);
		if (this.forDownloadTab)
		{
			// download tab only allows a single selection
			this._selectedProfileIds = [profile.geneticProfileId];
		}
		else
		{
			let difference = _.difference(this.selectedProfileIds, groupProfileIds);
			if (checked)
				this._selectedProfileIds = _.union(difference, [profile.geneticProfileId]);
			else
				this._selectedProfileIds = difference;
		}
	}

	@action replaceGene(oldSymbol:string, newSymbol:string)
	{
		this.geneQuery = normalizeQuery(this.geneQuery.toUpperCase().replace(new RegExp(`\\b${oldSymbol.toUpperCase()}\\b`, 'g'), () => newSymbol.toUpperCase()));
	}

	@action applyGeneSelection(map_geneSymbol_selected:ObservableMap<boolean>)
	{
		let [toAppend, toRemove] = _.partition(map_geneSymbol_selected.keys(), geneSymbol => map_geneSymbol_selected.get(geneSymbol));
		toAppend = _.difference(toAppend, this.geneIds);
		toRemove = _.intersection(toRemove, this.geneIds);
		for (let geneSymbol of toRemove)
			this.replaceGene(geneSymbol, '');
		this.geneQuery = normalizeQuery([this.geneQuery, ...toAppend].join(' '));
	}

	@action submit()
	{
		if (this.oql.error)
		{
			this.geneQueryErrorDisplayStatus = 'shouldFocus';
			return;
		}

		if (!this.submitEnabled || !this.asyncUrlParams.isComplete)
			return;

		let urlParams = this.asyncUrlParams.result;

		//TODO this is currently broken because of mobx-react-router
		// this is supposed to allow you to go back in the browser history to
		// return to the query page and restore the QueryStore state from the URL.
		/*let historyUrl = URL.format({...urlParams, pathname: window.location.href.split('?')[0]});

		// TODO remove this temporary HACK to make back button work
		historyUrl = historyUrl.split('#crosscancer').join('#/home#crosscancer');

		let newUrl = buildCBioPortalUrl(urlParams);
		if (historyUrl != newUrl)
			window.history.pushState(null, window.document.title, historyUrl);*/

		formSubmit(urlParams.pathname, urlParams.query);
	}

	@action openSummary() {

		if (!this.summaryEnabled) {
			return;
		}

		openStudySummaryFormSubmit(this.selectedStudyIds);
	}

	@action sendToGenomeSpace()
	{
		if (!this.submitEnabled || !this.asyncUrlParams.isComplete)
			return;

		gsUploadByGet({
			url: buildCBioPortalUrl(this.asyncUrlParams.result),
			filename: this.downloadDataFilename,
			successCallback: savePath => alert('Saved to GenomeSpace as ' + savePath),
			errorCallback: savePath => alert('ERROR saving to GenomeSpace as ' + savePath),
		});
	}
}

export const QueryStoreComponent = ComponentGetsStoreContext(QueryStore);
