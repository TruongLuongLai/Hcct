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

import { AddonModThrdAssignFeedbackPluginBaseComponent } from '@addons/mod/thrdassign/classes/base-feedback-plugin-component';
import { AddonModThrdAssign, AddonModThrdAssignProvider } from '@addons/mod/thrdassign/services/thrdassign';
import { Component, OnInit } from '@angular/core';
import { CoreWSFile } from '@services/ws';

/**
 * Component to render a file feedback plugin.
 */
@Component({
    selector: 'addon-mod-thrdassign-feedback-file',
    templateUrl: 'addon-mod-thrdassign-feedback-file.html',
})
export class AddonModThrdAssignFeedbackFileComponent extends AddonModThrdAssignFeedbackPluginBaseComponent implements OnInit {

    component = AddonModThrdAssignProvider.COMPONENT;
    files: CoreWSFile[] = [];

    /**
     * @inheritdoc
     */
    async ngOnInit(): Promise<void> {
        if (this.plugin) {
            this.files = AddonModThrdAssign.getSubmissionPluginAttachments(this.plugin);
        }
    }

}
