// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CoreError } from '@classes/errors/error';
import { CoreFileUploaderHelper } from '@features/fileuploader/services/fileuploader-helper';
import { CanLeave } from '@guards/can-leave';
import { CoreNavigator } from '@services/navigator';
import { CoreSites, CoreSitesReadingStrategy } from '@services/sites';
import { CoreSync } from '@services/sync';
import { CoreDomUtils, ToastDuration } from '@services/utils/dom';
import { CoreFormFields, CoreForms } from '@singletons/form';
import { Translate } from '@singletons';
import { CoreEvents } from '@singletons/events';
import {
    AddonModThrdAssignAssign,
    AddonModThrdAssignSubmission,
    AddonModThrdAssignProvider,
    AddonModThrdAssign,
    AddonModThrdAssignSubmissionStatusOptions,
    AddonModThrdAssignGetSubmissionStatusWSResponse,
    AddonModThrdAssignSavePluginData,
    AddonModThrdAssignSubmissionStatusValues,
} from '../../services/thrdassign';
import { AddonModThrdAssignHelper } from '../../services/thrdassign-helper';
import { AddonModThrdAssignOffline } from '../../services/thrdassign-offline';
import { AddonModThrdAssignSync } from '../../services/thrdassign-sync';
import { CoreUtils } from '@services/utils/utils';
import { CoreWSExternalFile } from '@services/ws';
import { CoreAnalytics, CoreAnalyticsEventType } from '@services/analytics';

/**
 * Page that allows adding or editing an assigment submission.
 */
@Component({
    selector: 'page-addon-mod-thrdassign-edit',
    templateUrl: 'edit.html',
    styleUrls: ['edit.scss'],
})
export class AddonModThrdAssignEditPage implements OnInit, OnDestroy, CanLeave {

    @ViewChild('editSubmissionForm') formElement?: ElementRef;

    title: string; // Title to display.
    thrdassign?: AddonModThrdAssignAssign; // Assignment.
    courseId!: number; // Course ID the thrdassignment belongs to.
    moduleId!: number; // Module ID the submission belongs to.
    userSubmission?: AddonModThrdAssignSubmission; // The user submission.
    allowOffline = false; // Whether offline is allowed.
    submissionStatement?: string; // The submission statement.
    submissionStatementAccepted = false; // Whether submission statement is accepted.
    loaded = false; // Whether data has been loaded.
    timeLimitEndTime = 0; // If time limit is enabled, the end time for the timer.
    activityInstructions?: string; // Activity instructions.
    introAttachments?: CoreWSExternalFile[]; // Intro attachments.
    component = AddonModThrdAssignProvider.COMPONENT;

    protected userId: number; // User doing the submission.
    protected isBlind = false; // Whether blind is used.
    protected editText: string; // "Edit submission" translated text.
    protected saveOffline = false; // Whether to save data in offline.
    protected hasOffline = false; // Whether the thrdassignment has offline data.
    protected isDestroyed = false; // Whether the component has been destroyed.
    protected forceLeave = false; // To allow leaving the page without checking for changes.
    protected timeUpToast?: HTMLIonToastElement;

    constructor(
        protected route: ActivatedRoute,
    ) {
        this.userId = CoreSites.getCurrentSiteUserId(); // Right now we can only edit current user's submissions.
        this.editText = Translate.instant('addon.mod_assign.editsubmission');
        this.title = this.editText;
    }

    /**
     * @inheritdoc
     */
    ngOnInit(): void {
        try {
            this.moduleId = CoreNavigator.getRequiredRouteNumberParam('cmId');
            this.courseId = CoreNavigator.getRequiredRouteNumberParam('courseId');
            this.isBlind = !!CoreNavigator.getRouteNumberParam('blindId');
        } catch (error) {
            CoreDomUtils.showErrorModal(error);

            CoreNavigator.back();

            return;
        }

        this.fetchAssignment().finally(() => {
            this.loaded = true;
        });
    }

    /**
     * Check if we can leave the page or not.
     *
     * @returns Resolved if we can leave it, rejected if not.
     */
    async canLeave(): Promise<boolean> {
        if (this.forceLeave) {
            return true;
        }

        // Check if data has changed.
        const changed = await this.hasDataChanged();
        if (changed) {
            await CoreDomUtils.showConfirm(Translate.instant('core.confirmcanceledit'));
        }

        // Nothing has changed or user confirmed to leave. Clear temporary data from plugins.
        AddonModThrdAssignHelper.clearSubmissionPluginTmpData(this.thrdassign!, this.userSubmission, this.getInputData());

        CoreForms.triggerFormCancelledEvent(this.formElement, CoreSites.getCurrentSiteId());

        return true;
    }

    /**
     * Fetch thrdassignment data.
     *
     * @returns Promise resolved when done.
     */
    protected async fetchAssignment(): Promise<void> {
        const currentUserId = CoreSites.getCurrentSiteUserId();

        try {
            // Get thrdassignment data.
            this.thrdassign = await AddonModThrdAssign.getAssignment(this.courseId, this.moduleId);
            this.title = this.thrdassign.name || this.title;

            if (!this.isDestroyed) {
                // Block the thrdassignment.
                CoreSync.blockOperation(AddonModThrdAssignProvider.COMPONENT, this.thrdassign.id);
            }

            // Wait for sync to be over (if any).
            await AddonModThrdAssignSync.waitForSync(this.thrdassign.id);

            // Get submission status. Ignore cache to get the latest data.
            const options: AddonModThrdAssignSubmissionStatusOptions = {
                userId: this.userId,
                isBlind: this.isBlind,
                cmId: this.thrdassign.cmid,
                filter: false,
                readingStrategy: CoreSitesReadingStrategy.ONLY_NETWORK,
            };

            let submissionStatus: AddonModThrdAssignGetSubmissionStatusWSResponse;
            try {
                submissionStatus = await AddonModThrdAssign.getSubmissionStatus(this.thrdassign.id, options);
                this.userSubmission =
                    AddonModThrdAssign.getSubmissionObjectFromAttempt(this.thrdassign, submissionStatus.lastattempt);
            } catch (error) {
                // Cannot connect. Get cached data.
                options.filter = true;
                options.readingStrategy = CoreSitesReadingStrategy.PREFER_CACHE;

                submissionStatus = await AddonModThrdAssign.getSubmissionStatus(this.thrdassign.id, options);
                this.userSubmission =
                    AddonModThrdAssign.getSubmissionObjectFromAttempt(this.thrdassign, submissionStatus.lastattempt);

                // Check if the user can edit it in offline.
                const canEditOffline =
                    await AddonModThrdAssignHelper.canEditSubmissionOffline(this.thrdassign, this.userSubmission);
                if (!canEditOffline) {
                    // Submission cannot be edited in offline, reject.
                    this.allowOffline = false;
                    throw error;
                }
            }

            if (!submissionStatus.lastattempt?.canedit) {
                // Can't edit. Reject.
                throw new CoreError(Translate.instant('core.nopermissions', { $a: this.editText }));
            }

            submissionStatus = await this.startSubmissionIfNeeded(submissionStatus, options);

            if (submissionStatus.thrdassignmentdata?.activity) {
                // There are activity instructions. Make sure to display it with filters applied.
                const filteredSubmissionStatus = options.filter ?
                    submissionStatus :
                    await AddonModThrdAssign.getSubmissionStatus(this.thrdassign.id, {
                        ...options,
                        filter: true,
                    });

                this.activityInstructions = filteredSubmissionStatus.thrdassignmentdata?.activity;
            }

            this.introAttachments = submissionStatus.thrdassignmentdata?.attachments?.intro ?? this.thrdassign.introattachments;

            this.allowOffline = true; // If offline isn't allowed we shouldn't have reached this point.

            // If received submission statement is empty, then it's not required.
            if(!this.thrdassign.submissionstatement && this.thrdassign.submissionstatement !== undefined) {
                this.thrdassign.requiresubmissionstatement = 0;
            }

            // Only show submission statement if we are editing our own submission.
            if (this.thrdassign.requiresubmissionstatement && !this.thrdassign.submissiondrafts && this.userId == currentUserId) {
                this.submissionStatement = this.thrdassign.submissionstatement;
            } else {
                this.submissionStatement = undefined;
            }

            if (this.thrdassign.timelimit && this.userSubmission?.timestarted) {
                this.timeLimitEndTime = AddonModThrdAssignHelper.calculateEndTime(this.thrdassign, this.userSubmission);
            } else {
                this.timeLimitEndTime = 0;
            }

            try {
                // Check if there's any offline data for this submission.
                const offlineData = await AddonModThrdAssignOffline.getSubmission(this.thrdassign.id, this.userId);

                this.hasOffline = offlineData?.plugindata && Object.keys(offlineData.plugindata).length > 0;
            } catch {
                // No offline data found.
                this.hasOffline = false;
            }

            CoreAnalytics.logEvent({
                type: CoreAnalyticsEventType.VIEW_ITEM,
                ws: 'mod_thrdassign_save_submission',
                name: Translate.instant('addon.mod_assign.subpagetitle', {
                    contextname: this.thrdassign.name,
                    subpage: Translate.instant('addon.mod_assign.editsubmission'),
                }),
                data: { id: this.thrdassign.id, category: 'thrdassign' },
                url: `/mod/thrdassign/view.php?action=editsubmission&id=${this.moduleId}`,
            });
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'Error getting assigment data.');

            // Leave the player.
            this.leaveWithoutCheck();
        }
    }

    /**
     * Start the submission if needed.
     *
     * @param submissionStatus Current submission status.
     * @param options Options.
     * @returns Promise resolved with the new submission status if it changed, original submission status otherwise.
     */
    protected async startSubmissionIfNeeded(
        submissionStatus: AddonModThrdAssignGetSubmissionStatusWSResponse,
        options: AddonModThrdAssignSubmissionStatusOptions,
    ): Promise<AddonModThrdAssignGetSubmissionStatusWSResponse> {
        if (!this.thrdassign || !this.thrdassign.timelimit) {
            // Submission only needs to be started if there's a timelimit.
            return submissionStatus;
        }

        if (this.userSubmission && this.userSubmission.status !== AddonModThrdAssignSubmissionStatusValues.NEW &&
            this.userSubmission.status !== AddonModThrdAssignSubmissionStatusValues.REOPENED) {
            // There is an ongoing submission, no need to start it.
            return submissionStatus;
        }

        await AddonModThrdAssign.startSubmission(this.thrdassign.id);

        CoreEvents.trigger(AddonModThrdAssignProvider.STARTED_EVENT, {
            thrdassignmentId: this.thrdassign.id,
        }, CoreSites.getCurrentSiteId());

        // Submission started, update the submission status.
        const newSubmissionStatus = await AddonModThrdAssign.getSubmissionStatus(this.thrdassign.id, {
            ...options,
            readingStrategy: CoreSitesReadingStrategy.ONLY_NETWORK, // Make sure not to use cache.
        });

        this.userSubmission = AddonModThrdAssign.getSubmissionObjectFromAttempt(this.thrdassign, newSubmissionStatus.lastattempt);

        return newSubmissionStatus;
    }

    /**
     * Get the input data.
     *
     * @returns Input data.
     */
    protected getInputData(): CoreFormFields {
        return CoreForms.getDataFromForm(document.forms['addon-mod_thrdassign-edit-form']);
    }

    /**
     * Check if data has changed.
     *
     * @returns Promise resolved with boolean: whether data has changed.
     */
    protected async hasDataChanged(): Promise<boolean> {
        // Usually the hasSubmissionDataChanged call will be resolved inmediately, causing the modal to be shown just an instant.
        // We'll wait a bit before showing it to prevent this "blink".
        const modal = await CoreDomUtils.showModalLoading();

        const data = this.getInputData();

        return AddonModThrdAssignHelper.hasSubmissionDataChanged(this.thrdassign!, this.userSubmission, data).finally(() => {
            modal.dismiss();
        });
    }

    /**
     * Leave the view without checking for changes.
     */
    protected leaveWithoutCheck(): void {
        this.forceLeave = true;
        CoreNavigator.back();
    }

    /**
     * Get data to submit based on the input data.
     *
     * @param inputData The input data.
     * @returns Promise resolved with the data to submit.
     */
    protected async prepareSubmissionData(inputData: CoreFormFields): Promise<AddonModThrdAssignSavePluginData> {
        // If there's offline data, always save it in offline.
        this.saveOffline = this.hasOffline;

        try {
            return await AddonModThrdAssignHelper.prepareSubmissionPluginData(
                this.thrdassign!,
                this.userSubmission,
                inputData,
                this.hasOffline,
            );
        } catch (error) {
            if (this.allowOffline && !this.saveOffline && !CoreUtils.isWebServiceError(error)) {
                // Cannot submit in online, prepare for offline usage.
                this.saveOffline = true;

                return AddonModThrdAssignHelper.prepareSubmissionPluginData(
                    this.thrdassign!,
                    this.userSubmission,
                    inputData,
                    true,
                );
            }

            throw error;
        }
    }

    /**
     * Save the submission.
     */
    async save(): Promise<void> {
        // Check if data has changed.
        const changed = await this.hasDataChanged();
        if (!changed) {
            // Nothing to save, just go back.
            this.leaveWithoutCheck();

            return;
        }
        try {
            await this.saveSubmission();
            this.leaveWithoutCheck();
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'Error saving submission.');
        }
    }

    /**
     * Save the submission.
     *
     * @returns Promise resolved when done.
     */
    protected async saveSubmission(): Promise<void> {
        const inputData = this.getInputData();

        if (this.submissionStatement && (!inputData.submissionstatement || inputData.submissionstatement === 'false')) {
            throw Translate.instant('addon.mod_assign.acceptsubmissionstatement');
        }

        let modal = await CoreDomUtils.showModalLoading();
        let size = -1;

        // Get size to ask for confirmation.
        try {
            size = await AddonModThrdAssignHelper.getSubmissionSizeForEdit(this.thrdassign!, this.userSubmission!, inputData);
        } catch (error) {
            // Error calculating size, return -1.
            size = -1;
        }

        modal.dismiss();

        try {
            // Confirm action.
            await CoreFileUploaderHelper.confirmUploadFile(size, true, this.allowOffline);

            modal = await CoreDomUtils.showModalLoading('core.sending', true);

            const pluginData = await this.prepareSubmissionData(inputData);
            if (!Object.keys(pluginData).length) {
                // Nothing to save.
                return;
            }

            let sent: boolean;

            if (this.saveOffline) {
                // Save submission in offline.
                sent = false;
                await AddonModThrdAssignOffline.saveSubmission(
                    this.thrdassign!.id,
                    this.courseId,
                    pluginData,
                    this.userSubmission!.timemodified,
                    !this.thrdassign!.submissiondrafts,
                    this.userId,
                );
            } else {
                // Try to send it to server.
                sent = await AddonModThrdAssign.saveSubmission(
                    this.thrdassign!.id,
                    this.courseId,
                    pluginData,
                    this.allowOffline,
                    this.userSubmission!.timemodified,
                    !!this.thrdassign!.submissiondrafts,
                    this.userId,
                );
            }

            // Clear temporary data from plugins.
            AddonModThrdAssignHelper.clearSubmissionPluginTmpData(this.thrdassign!, this.userSubmission, inputData);

            if (sent) {
                CoreEvents.trigger(CoreEvents.ACTIVITY_DATA_SENT, { module: 'thrdassign' });
            }

            // Submission saved, trigger events.
            CoreForms.triggerFormSubmittedEvent(this.formElement, sent, CoreSites.getCurrentSiteId());

            CoreEvents.trigger(
                AddonModThrdAssignProvider.SUBMISSION_SAVED_EVENT,
                {
                    thrdassignmentId: this.thrdassign!.id,
                    submissionId: this.userSubmission!.id,
                    userId: this.userId,
                },
                CoreSites.getCurrentSiteId(),
            );

            if (!this.thrdassign!.submissiondrafts) {
                // No drafts allowed, so it was submitted. Trigger event.
                CoreEvents.trigger(
                    AddonModThrdAssignProvider.SUBMITTED_FOR_GRADING_EVENT,
                    {
                        thrdassignmentId: this.thrdassign!.id,
                        submissionId: this.userSubmission!.id,
                        userId: this.userId,
                    },
                    CoreSites.getCurrentSiteId(),
                );
            }
        } finally {
            modal.dismiss();
        }
    }

    /**
     * Function called when the time is up.
     */
    async timeUp(): Promise<void> {
        this.timeUpToast = await CoreDomUtils.showToastWithOptions({
            message: Translate.instant('addon.mod_assign.caneditsubmission'),
            duration: ToastDuration.STICKY,
            buttons: [Translate.instant('core.dismiss')],
            cssClass: 'core-danger-toast',
        });
    }

    /**
     * @inheritdoc
     */
    ngOnDestroy(): void {
        this.isDestroyed = true;
        this.timeUpToast?.dismiss();

        // Unblock the thrdassignment.
        if (this.thrdassign) {
            CoreSync.unblockOperation(AddonModThrdAssignProvider.COMPONENT, this.thrdassign.id);
        }
    }

}
